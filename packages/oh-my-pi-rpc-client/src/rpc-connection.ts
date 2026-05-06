import { randomUUID } from "node:crypto";
import type {
	CreateSessionOptions,
	HostUiResponse,
	RunFailedEvent,
	SessionClosedEvent,
	SessionDriverEvent,
	SessionMessageInput,
	SessionOpenedEvent,
	SessionRef,
	SessionSnapshot,
	WorkspaceRef,
} from "@pi-gui/session-driver";

import {
	type CachedAvailableCommand,
	type ExtensionUiRequestMapping,
	makeSessionUpdatedEvent,
	mapRpcEventToSessionEvent,
	mapRpcExtensionErrorToSessionEvent,
	mapRpcExtensionUiRequestToHostUiRequest,
} from "./event-adapter.js";
import type {
	RpcAgentSessionEvent,
	RpcCommand,
	RpcExtensionErrorEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcInboundMessage,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";
import type { OmpSidecarHandle } from "./sidecar-process.js";

export type RpcSessionEventListener = (event: SessionDriverEvent) => void;

export interface RpcConnection {
	subscribe(sessionRef: SessionRef, listener: RpcSessionEventListener): () => void;
	startSession(workspace: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot>;
	sendPrompt(sessionRef: SessionRef, input: SessionMessageInput): Promise<void>;
	cancelRun(sessionRef: SessionRef): Promise<void>;
	closeSession(sessionRef: SessionRef): Promise<void>;
	respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void>;
	renameSessionLocal(sessionRef: SessionRef, title: string): void;
	getSnapshot(sessionRef: SessionRef): SessionSnapshot | undefined;
	getAvailableCommands(sessionRef: SessionRef): readonly CachedAvailableCommand[];
	dispose(): Promise<void>;
}

const READY_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EXTENSION_UI_TIMEOUT_MS = 60_000;

interface PendingCommand {
	resolve: (res: RpcResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingExtensionUi {
	mapping: ExtensionUiRequestMapping;
	sessionId: string;
	timer: ReturnType<typeof setTimeout>;
}

interface InFlightRun {
	runId: string;
	sessionId: string;
}

function serializeError(err: unknown): Record<string, unknown> | unknown {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: err.message,
			stack: err.stack,
			cause: err.cause !== undefined ? String(err.cause) : undefined,
		};
	}
	return err;
}

/**
 * NDJSON line splitter over a Node `Readable` (child stdout). Emits one
 * complete JSON-parsed message per newline; buffers partial tails across
 * `data` chunks. Ignores blank lines. Logs JSON parse errors to stderr
 * without killing the connection — malformed lines are typically noise
 * (e.g. a stray log write) rather than fatal protocol errors.
 */
function readNdjson(
	stdout: NodeJS.ReadableStream,
	onMessage: (msg: RpcInboundMessage) => void,
	onEnd: () => void,
): void {
	let buffer = "";
	stdout.setEncoding?.("utf8");
	stdout.on("data", chunk => {
		buffer += chunk;
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				try {
					onMessage(JSON.parse(line) as RpcInboundMessage);
				} catch (err) {
					process.stderr.write(
						`[oh-my-pi-rpc-client] failed to parse NDJSON line: ${(err as Error).message}\n  line: ${line.slice(0, 200)}\n`,
					);
				}
			}
			newlineIndex = buffer.indexOf("\n");
		}
	});
	stdout.once("end", onEnd);
	stdout.once("close", onEnd);
}

export function createRpcConnection(sidecar: OmpSidecarHandle, workspaceId: string): RpcConnection {
	const stdin = sidecar.process.stdin;
	const stdout = sidecar.process.stdout;

	const listenersBySession = new Map<string, Set<RpcSessionEventListener>>();
	const openSessions = new Map<string, SessionSnapshot>();
	const pendingCommands = new Map<string, PendingCommand>();
	const pendingExtensionUi = new Map<string, PendingExtensionUi>();
	const availableCommandsBySession = new Map<string, readonly CachedAvailableCommand[]>();
	const inFlightRuns = new Map<string, InFlightRun>();

	let readyResolve: (() => void) | undefined;
	let readyReject: ((err: Error) => void) | undefined;
	const readyPromise = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const readyTimer = setTimeout(() => {
		readyReject?.(new Error("RPC sidecar did not emit `ready` within timeout"));
	}, READY_TIMEOUT_MS);

	let disposed = false;

	function now(): string {
		return new Date().toISOString();
	}

	function emitToSession(sessionId: string, event: SessionDriverEvent): void {
		const listeners = listenersBySession.get(sessionId);
		if (!listeners) return;
		for (const listener of listeners) listener(event);
	}

	function hasListeners(sessionId: string): boolean {
		const set = listenersBySession.get(sessionId);
		return !!set && set.size > 0;
	}

	function writeCommand(command: RpcCommand): void {
		if (disposed) throw new Error("RPC connection is disposed");
		stdin.write(`${JSON.stringify(command)}\n`);
	}

	// Accept the full RpcCommand shape (with optional `id`). Using
	// `Omit<RpcCommand, "id">` distributes poorly over a discriminated union —
	// `keyof` on the union reduces to the common keys (just `type`), and the
	// narrowing by `type` literal breaks. Callers either include `id` or we
	// auto-assign one before send.
	function sendCommand<TData = unknown>(command: RpcCommand): Promise<RpcResponse & { data?: TData }> {
		const id = command.id ?? randomUUID();
		const payload: RpcCommand = { ...command, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingCommands.delete(id);
				reject(new Error(`RPC command "${command.type}" timed out after ${COMMAND_TIMEOUT_MS}ms`));
			}, COMMAND_TIMEOUT_MS);
			pendingCommands.set(id, {
				resolve: res => resolve(res as RpcResponse & { data?: TData }),
				reject,
				timer,
			});
			try {
				writeCommand(payload);
			} catch (err) {
				clearTimeout(timer);
				pendingCommands.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	function writeExtensionUiResponse(response: RpcExtensionUIResponse): void {
		if (disposed) return;
		stdin.write(`${JSON.stringify(response)}\n`);
	}

	function getSingleSessionId(): string | undefined {
		// RPC mode runs one session per sidecar process. The active session's id
		// is the sole entry in `openSessions`. If multiple are present (future
		// multi-session support), callers pass a `SessionRef` and we look it up.
		if (openSessions.size === 0) return undefined;
		return openSessions.keys().next().value;
	}

	function finishRun(sessionId: string, error?: { message: string; code?: string; details?: unknown }): void {
		const run = inFlightRuns.get(sessionId);
		if (!run) return;
		inFlightRuns.delete(sessionId);
		const snapshot = openSessions.get(sessionId);
		if (!snapshot) return;
		const updated: SessionSnapshot = { ...snapshot, status: "idle", updatedAt: now() };
		openSessions.set(sessionId, updated);
		if (error) {
			const event: RunFailedEvent = {
				type: "runFailed",
				sessionRef: snapshot.ref,
				timestamp: updated.updatedAt,
				runId: run.runId,
				error,
			};
			emitToSession(sessionId, event);
		} else {
			emitToSession(sessionId, {
				type: "runCompleted",
				sessionRef: snapshot.ref,
				timestamp: updated.updatedAt,
				runId: run.runId,
				snapshot: updated,
			});
		}
	}

	function handleResponse(msg: RpcResponse): void {
		const id = msg.id;
		if (!id) return;
		const pending = pendingCommands.get(id);
		if (!pending) return;
		pendingCommands.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(msg);
	}

	function handleExtensionUiRequest(msg: RpcExtensionUIRequest): void {
		const sessionId = getSingleSessionId();
		if (!sessionId) {
			// No session is open — auto-cancel so the extension doesn't hang.
			writeExtensionUiResponse({ type: "extension_ui_response", id: msg.id, cancelled: true });
			return;
		}
		const snapshot = openSessions.get(sessionId);
		if (!snapshot) {
			writeExtensionUiResponse({ type: "extension_ui_response", id: msg.id, cancelled: true });
			return;
		}
		if (!hasListeners(sessionId)) {
			// Renderer not attached — auto-cancel rather than wedging the agent.
			writeExtensionUiResponse({ type: "extension_ui_response", id: msg.id, cancelled: true });
			return;
		}

		const requestId = randomUUID();
		const mapping = mapRpcExtensionUiRequestToHostUiRequest(msg, snapshot.ref, now(), requestId);

		const timer = setTimeout(() => {
			const pending = pendingExtensionUi.get(requestId);
			if (!pending) return;
			pendingExtensionUi.delete(requestId);
			writeExtensionUiResponse({ type: "extension_ui_response", id: mapping.extensionUiRequestId, cancelled: true });
		}, EXTENSION_UI_TIMEOUT_MS);

		pendingExtensionUi.set(requestId, { mapping, sessionId, timer });
		emitToSession(sessionId, mapping.event);
	}

	function handleExtensionError(msg: RpcExtensionErrorEvent): void {
		const sessionId = getSingleSessionId();
		if (!sessionId) return;
		const snapshot = openSessions.get(sessionId);
		if (!snapshot) return;
		emitToSession(sessionId, mapRpcExtensionErrorToSessionEvent(msg, snapshot.ref, now()));
	}

	function handleAgentSessionEvent(msg: RpcAgentSessionEvent): void {
		const sessionId = getSingleSessionId();
		if (!sessionId) return;
		const snapshot = openSessions.get(sessionId);
		if (!snapshot) return;
		const run = inFlightRuns.get(sessionId);

		// Lifecycle events that drive run completion — emit explicit runCompleted /
		// runFailed from here (the RPC `prompt` command resolves its response
		// immediately, before the turn ends).
		if (msg.type === "agent_end") {
			finishRun(sessionId);
			return;
		}
		if (msg.type === "turn_end") {
			// turn_end fires once per assistant turn; agent_end fires when the full
			// run ends (all queued follow-ups drained). We pin runCompleted to
			// agent_end. A turn with stopReason=error could come through turn_end
			// first; don't emit runCompleted here, but flag for runFailed below.
			return;
		}

		const streamingEvent = mapRpcEventToSessionEvent(msg, snapshot.ref, now(), run?.runId);
		if (streamingEvent) {
			emitToSession(sessionId, streamingEvent);
		}
	}

	function handleIncoming(msg: RpcInboundMessage): void {
		const type = (msg as { type?: string }).type;
		if (type === "response") {
			handleResponse(msg as RpcResponse);
			return;
		}
		if (type === "ready") {
			if (readyResolve) {
				clearTimeout(readyTimer);
				readyResolve();
				readyResolve = undefined;
				readyReject = undefined;
			}
			return;
		}
		if (type === "extension_ui_request") {
			handleExtensionUiRequest(msg as RpcExtensionUIRequest);
			return;
		}
		if (type === "extension_error") {
			handleExtensionError(msg as RpcExtensionErrorEvent);
			return;
		}
		// Host-tool protocol: not wired through the SessionDriver yet. Ignore and
		// let the agent time out — consumers that need host tools should send
		// `set_host_tools` + handle these requests directly via a separate API.
		if (type === "host_tool_call" || type === "host_tool_cancel") {
			return;
		}
		// Everything else is an AgentSessionEvent.
		handleAgentSessionEvent(msg as RpcAgentSessionEvent);
	}

	function handleStreamEnd(): void {
		if (disposed) return;
		// Flush pending commands with rejection so callers don't hang.
		for (const [id, pending] of pendingCommands) {
			clearTimeout(pending.timer);
			pending.reject(new Error("RPC sidecar stdout closed before response"));
			pendingCommands.delete(id);
		}
		if (readyReject) {
			clearTimeout(readyTimer);
			readyReject(new Error("RPC sidecar stdout closed before `ready`"));
			readyResolve = undefined;
			readyReject = undefined;
		}
		// Emit sessionClosed to any subscribers so the renderer knows.
		for (const [sessionId, snapshot] of openSessions) {
			const event: SessionClosedEvent = {
				type: "sessionClosed",
				sessionRef: snapshot.ref,
				timestamp: now(),
				reason: "failed",
			};
			emitToSession(sessionId, event);
		}
	}

	readNdjson(stdout, handleIncoming, handleStreamEnd);

	return {
		subscribe(sessionRef, listener) {
			const key = sessionRef.sessionId;
			let set = listenersBySession.get(key);
			if (!set) {
				set = new Set();
				listenersBySession.set(key, set);
			}
			set.add(listener);
			return () => {
				const current = listenersBySession.get(key);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) listenersBySession.delete(key);
			};
		},

		async startSession(workspace, options) {
			await readyPromise;
			// One session per sidecar in this slice: if a session is already open,
			// close it first. Multi-session support = spawn a second sidecar.
			if (openSessions.size > 0) {
				for (const [sessionId, snapshot] of openSessions) {
					emitToSession(sessionId, {
						type: "sessionClosed",
						sessionRef: snapshot.ref,
						timestamp: now(),
						reason: "ended",
					});
				}
				openSessions.clear();
				availableCommandsBySession.clear();
				inFlightRuns.clear();
			}

			const res = await sendCommand({ type: "new_session" });
			if (!res.success) {
				throw new Error(`new_session failed: ${(res as { error: string }).error}`);
			}
			if ((res.data as { cancelled?: boolean })?.cancelled) {
				throw new Error("new_session was cancelled by the sidecar");
			}

			const stateRes = await sendCommand<RpcSessionState>({ type: "get_state" });
			if (!stateRes.success || !stateRes.data) {
				throw new Error(`get_state failed after new_session: ${(stateRes as { error?: string }).error ?? "no data"}`);
			}
			const state = stateRes.data;
			const sessionRef: SessionRef = { workspaceId: workspace.workspaceId, sessionId: state.sessionId };
			const snapshot: SessionSnapshot = {
				ref: sessionRef,
				workspace,
				title: options?.title ?? state.sessionName ?? "New session",
				status: state.isStreaming ? "running" : "idle",
				updatedAt: now(),
				config: {
					thinkingLevel: state.thinkingLevel,
				},
			};
			openSessions.set(state.sessionId, snapshot);
			const event: SessionOpenedEvent = {
				type: "sessionOpened",
				sessionRef,
				timestamp: snapshot.updatedAt,
				snapshot,
			};
			emitToSession(state.sessionId, event);
			return snapshot;
		},

		async sendPrompt(sessionRef, input) {
			await readyPromise;
			const snapshot = openSessions.get(sessionRef.sessionId);
			if (!snapshot) {
				throw new Error(`sendPrompt: session ${sessionRef.sessionId} is not open`);
			}
			const runId = randomUUID();
			inFlightRuns.set(sessionRef.sessionId, { runId, sessionId: sessionRef.sessionId });
			const updated: SessionSnapshot = { ...snapshot, status: "running", updatedAt: now(), runningRunId: runId };
			openSessions.set(sessionRef.sessionId, updated);

			try {
				const res = await sendCommand({
					type: "prompt",
					message: input.text,
					streamingBehavior: input.deliverAs ?? "steer",
				});
				if (!res.success) {
					const errMessage = (res as { error: string }).error;
					finishRun(sessionRef.sessionId, { message: errMessage });
					return;
				}
				// Success response is the "accepted" ack — run completion is driven
				// by `agent_end` in the event stream (see handleAgentSessionEvent).
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				finishRun(sessionRef.sessionId, { message, details: serializeError(err) });
				throw err;
			}
		},

		async cancelRun(sessionRef) {
			await readyPromise;
			if (!openSessions.has(sessionRef.sessionId)) return;
			await sendCommand({ type: "abort" });
			// `agent_end` should follow; finishRun will clean up from there. If the
			// sidecar doesn't emit agent_end on abort, callers may see a stale
			// `running` status — we rely on the agent for correctness here, same as
			// the ACP client does via StopReason::cancelled.
		},

		async respondToHostUiRequest(_sessionRef, response) {
			const pending = pendingExtensionUi.get(response.requestId);
			if (!pending) return;
			pendingExtensionUi.delete(response.requestId);
			clearTimeout(pending.timer);

			if ("cancelled" in response && response.cancelled) {
				writeExtensionUiResponse({
					type: "extension_ui_response",
					id: pending.mapping.extensionUiRequestId,
					cancelled: true,
				});
				return;
			}
			if ("confirmed" in response) {
				writeExtensionUiResponse({
					type: "extension_ui_response",
					id: pending.mapping.extensionUiRequestId,
					confirmed: response.confirmed,
				});
				return;
			}
			if ("value" in response) {
				writeExtensionUiResponse({
					type: "extension_ui_response",
					id: pending.mapping.extensionUiRequestId,
					value: response.value,
				});
			}
		},

		getAvailableCommands(sessionRef) {
			return availableCommandsBySession.get(sessionRef.sessionId) ?? [];
		},

		getSnapshot(sessionRef) {
			return openSessions.get(sessionRef.sessionId);
		},

		renameSessionLocal(sessionRef, title) {
			const current = openSessions.get(sessionRef.sessionId);
			if (!current) return;
			const updated: SessionSnapshot = { ...current, title, updatedAt: now() };
			openSessions.set(sessionRef.sessionId, updated);
			emitToSession(sessionRef.sessionId, makeSessionUpdatedEvent(updated));
			// Best-effort persist to the sidecar — ignore failures, local UI is
			// authoritative for renames.
			sendCommand({ type: "set_session_name", name: title }).catch(() => undefined);
		},

		async closeSession(sessionRef) {
			const snapshot = openSessions.get(sessionRef.sessionId);
			if (!snapshot) return;
			emitToSession(sessionRef.sessionId, {
				type: "sessionClosed",
				sessionRef: snapshot.ref,
				timestamp: now(),
				reason: "manual",
			});
			openSessions.delete(sessionRef.sessionId);
			availableCommandsBySession.delete(sessionRef.sessionId);
			listenersBySession.delete(sessionRef.sessionId);
			inFlightRuns.delete(sessionRef.sessionId);
		},

		async dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(readyTimer);
			for (const [sessionId, snapshot] of openSessions) {
				const event: SessionClosedEvent = {
					type: "sessionClosed",
					sessionRef: snapshot.ref,
					timestamp: now(),
					reason: "manual",
				};
				emitToSession(sessionId, event);
			}
			for (const pending of pendingExtensionUi.values()) {
				clearTimeout(pending.timer);
				writeExtensionUiResponse({
					type: "extension_ui_response",
					id: pending.mapping.extensionUiRequestId,
					cancelled: true,
				});
			}
			for (const pending of pendingCommands.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("RPC connection disposed"));
			}
			pendingCommands.clear();
			pendingExtensionUi.clear();
			listenersBySession.clear();
			openSessions.clear();
			availableCommandsBySession.clear();
			inFlightRuns.clear();
			await sidecar.stop();
		},
	};
}

// Surface for smoke tests / advanced consumers that want to peek at the
// cached slash commands without going through the SessionDriver shim.
export type { RpcSlashCommand };
