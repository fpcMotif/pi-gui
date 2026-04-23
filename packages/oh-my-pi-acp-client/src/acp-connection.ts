import {
	type Agent,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type {
	CreateSessionOptions,
	HostUiResponse,
	RunFailedEvent,
	SessionClosedEvent,
	SessionDriverEvent,
	SessionOpenedEvent,
	SessionRef,
	SessionSnapshot,
	SessionMessageInput,
	WorkspaceRef,
} from "@pi-gui/session-driver";
import {
	type CachedAvailableCommand,
	mapAcpPermissionToHostUiRequest,
	mapAcpUpdateToSessionEvent,
	makeSessionUpdatedEvent,
	mergeAcpSessionInfoUpdate,
} from "./event-adapter.js";
import type { OmpSidecarHandle } from "./sidecar-process.js";

export type AcpSessionEventListener = (event: SessionDriverEvent) => void;

export interface AcpConnection {
	agent: Agent;
	subscribe(sessionRef: SessionRef, listener: AcpSessionEventListener): () => void;
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

type AcpPermissionOutcome =
	| { outcome: { outcome: "cancelled" } }
	| { outcome: { outcome: "selected"; optionId: string } };

interface PendingPermission {
	resolve: (value: AcpPermissionOutcome) => void;
	optionIdByLabel: Map<string, string>;
	allowOptionId?: string;
	rejectOptionId?: string;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Safely serialize an arbitrary thrown value for transport over Tauri IPC /
 * JSON. `Error` instances have non-enumerable `message`/`stack`, so naive
 * `JSON.stringify(err)` produces `{}`.
 */
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

const PERMISSION_TIMEOUT_MS = 60_000;

export function createAcpConnection(sidecar: OmpSidecarHandle, workspaceId: string): AcpConnection {
	const { output, input } = sidecar.webStreams();
	const stream = ndJsonStream(output, input);

	const listenersBySession = new Map<string, Set<AcpSessionEventListener>>();
	const openSessions = new Map<string, SessionSnapshot>();
	const pendingPermissions = new Map<string, PendingPermission>();
	const availableCommandsBySession = new Map<string, readonly CachedAvailableCommand[]>();

	let initializePromise: Promise<void> | undefined;

	function emitToSession(sessionId: string, event: SessionDriverEvent): void {
		const listeners = listenersBySession.get(sessionId);
		if (!listeners) return;
		for (const listener of listeners) listener(event);
	}

	function hasListeners(sessionId: string): boolean {
		const set = listenersBySession.get(sessionId);
		return !!set && set.size > 0;
	}

	const client: Client = {
		async sessionUpdate(params) {
			const update = params.update as unknown as {
				sessionUpdate: string;
				title?: string | null;
				updatedAt?: string | null;
				availableCommands?: readonly CachedAvailableCommand[];
			} & Record<string, unknown>;
			const sessionRef: SessionRef = { workspaceId, sessionId: params.sessionId };

			const streamingEvent = mapAcpUpdateToSessionEvent(update, sessionRef, new Date().toISOString());
			if (streamingEvent) {
				emitToSession(params.sessionId, streamingEvent);
				return;
			}

			if (update.sessionUpdate === "session_info_update") {
				const current = openSessions.get(params.sessionId);
				if (!current) return;
				const merged = mergeAcpSessionInfoUpdate(current, update);
				openSessions.set(params.sessionId, merged);
				emitToSession(params.sessionId, makeSessionUpdatedEvent(merged));
				return;
			}

			if (update.sessionUpdate === "available_commands_update") {
				if (update.availableCommands) {
					availableCommandsBySession.set(params.sessionId, update.availableCommands);
				}
				return;
			}

			// current_mode_update, config_option_update, usage_update, plan,
			// agent_thought_chunk, user_message_chunk — see event-adapter.ts TODOs.
		},
		async requestPermission(params) {
			const requestId = randomUUID();
			const mapping = mapAcpPermissionToHostUiRequest(
				params as unknown as Parameters<typeof mapAcpPermissionToHostUiRequest>[0],
				{ workspaceId, sessionId: params.sessionId },
				new Date().toISOString(),
				requestId,
			);

			// If nothing is listening to this session (renderer not attached /
			// crashed), auto-cancel instead of awaiting forever — otherwise the
			// agent's tool call wedges until the whole process dies.
			if (!hasListeners(params.sessionId)) {
				return { outcome: { outcome: "cancelled" } };
			}

			return new Promise<AcpPermissionOutcome>(resolve => {
				const timer = setTimeout(() => {
					pendingPermissions.delete(requestId);
					resolve({ outcome: { outcome: "cancelled" } });
				}, PERMISSION_TIMEOUT_MS);
				pendingPermissions.set(requestId, {
					resolve,
					optionIdByLabel: mapping.optionIdByLabel,
					allowOptionId: mapping.allowOptionId,
					rejectOptionId: mapping.rejectOptionId,
					timer,
				});
				emitToSession(params.sessionId, mapping.event);
			});
		},
	};

	const connection = new ClientSideConnection(() => client, stream);

	async function ensureInitialized(): Promise<void> {
		if (!initializePromise) {
			initializePromise = connection
				.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
				})
				.then(() => undefined)
				.catch(err => {
					// Clear so a subsequent call can retry after a transient fault.
					initializePromise = undefined;
					throw err;
				});
		}
		return initializePromise;
	}

	function now(): string {
		return new Date().toISOString();
	}

	return {
		agent: connection,
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
			await ensureInitialized();
			const resp = await connection.newSession({ cwd: workspace.path, mcpServers: [] });
			const sessionRef: SessionRef = { workspaceId: workspace.workspaceId, sessionId: resp.sessionId };
			const snapshotTitle = options?.title ?? "New session";
			const snapshot: SessionSnapshot = {
				ref: sessionRef,
				workspace,
				title: snapshotTitle,
				status: "idle",
				updatedAt: now(),
				config: {
					provider: options?.initialModel?.provider,
					modelId: options?.initialModel?.modelId,
					thinkingLevel: options?.initialThinkingLevel,
				},
			};
			openSessions.set(resp.sessionId, snapshot);
			const event: SessionOpenedEvent = {
				type: "sessionOpened",
				sessionRef,
				timestamp: snapshot.updatedAt,
				snapshot,
			};
			emitToSession(resp.sessionId, event);
			return snapshot;
		},
		async sendPrompt(sessionRef, input) {
			await ensureInitialized();
			const runId = randomUUID();
			try {
				const response = await connection.prompt({
					sessionId: sessionRef.sessionId,
					prompt: [{ type: "text", text: input.text }],
				});
				const stopReason = response.stopReason;
				const failed = stopReason === "refusal";
				const snapshot = openSessions.get(sessionRef.sessionId);
				if (!snapshot) return;
				const updated: SessionSnapshot = { ...snapshot, status: "idle", updatedAt: now() };
				openSessions.set(sessionRef.sessionId, updated);
				if (failed) {
					const event: RunFailedEvent = {
						type: "runFailed",
						sessionRef,
						timestamp: updated.updatedAt,
						runId,
						error: { message: `Agent refused: ${stopReason}`, code: stopReason },
					};
					emitToSession(sessionRef.sessionId, event);
				} else {
					emitToSession(sessionRef.sessionId, {
						type: "runCompleted",
						sessionRef,
						timestamp: updated.updatedAt,
						runId,
						snapshot: updated,
					});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const event: RunFailedEvent = {
					type: "runFailed",
					sessionRef,
					timestamp: now(),
					runId,
					error: { message, details: serializeError(err) },
				};
				emitToSession(sessionRef.sessionId, event);
				throw err;
			}
		},
		async respondToHostUiRequest(_sessionRef, response) {
			const pending = pendingPermissions.get(response.requestId);
			if (!pending) return;
			pendingPermissions.delete(response.requestId);
			if (pending.timer) clearTimeout(pending.timer);

			if ("cancelled" in response && response.cancelled) {
				pending.resolve({ outcome: { outcome: "cancelled" } });
				return;
			}
			if ("confirmed" in response) {
				// Pick by kind (allow_* / reject_*), NOT by positional label order —
				// the agent is free to serialize options in any order.
				const optionId = response.confirmed ? pending.allowOptionId : pending.rejectOptionId;
				if (!optionId) {
					pending.resolve({ outcome: { outcome: "cancelled" } });
					return;
				}
				pending.resolve({ outcome: { outcome: "selected", optionId } });
				return;
			}
			if ("value" in response) {
				const optionId = pending.optionIdByLabel.get(response.value);
				if (!optionId) {
					pending.resolve({ outcome: { outcome: "cancelled" } });
					return;
				}
				pending.resolve({ outcome: { outcome: "selected", optionId } });
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
		},
		async cancelRun(sessionRef) {
			await ensureInitialized();
			await connection.cancel({ sessionId: sessionRef.sessionId });
			// The in-flight `prompt` promise will resolve with StopReason::cancelled;
			// sendPrompt's branch emits the appropriate runCompleted/runFailed event.
		},
		async closeSession(sessionRef) {
			const snapshot = openSessions.get(sessionRef.sessionId);
			if (!snapshot) return;
			// Emit BEFORE tearing down listener set, otherwise subscribers never
			// learn the session closed.
			emitToSession(sessionRef.sessionId, {
				type: "sessionClosed",
				sessionRef: snapshot.ref,
				timestamp: now(),
				reason: "manual",
			});
			openSessions.delete(sessionRef.sessionId);
			availableCommandsBySession.delete(sessionRef.sessionId);
			listenersBySession.delete(sessionRef.sessionId);
		},
		async dispose() {
			// Emit sessionClosed for each open session BEFORE clearing listener sets.
			for (const [sessionId, snapshot] of openSessions) {
				const event: SessionClosedEvent = {
					type: "sessionClosed",
					sessionRef: snapshot.ref,
					timestamp: now(),
					reason: "manual",
				};
				emitToSession(sessionId, event);
			}
			for (const pending of pendingPermissions.values()) {
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve({ outcome: { outcome: "cancelled" } });
			}
			pendingPermissions.clear();
			listenersBySession.clear();
			openSessions.clear();
			availableCommandsBySession.clear();
			await sidecar.stop();
		},
	};
}
