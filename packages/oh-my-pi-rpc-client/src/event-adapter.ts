import type {
	AssistantDeltaEvent,
	ExtensionCompatibilityIssueEvent,
	HostUiRequest,
	HostUiRequestEvent,
	SessionDriverEvent,
	SessionRef,
	SessionSnapshot,
	SessionUpdatedEvent,
	ToolFinishedEvent,
	ToolStartedEvent,
	ToolUpdatedEvent,
} from "@pi-gui/session-driver";

import type { RpcExtensionErrorEvent, RpcExtensionUIRequest, RpcAgentSessionEvent } from "./rpc-types.js";

export interface RpcEventAdapter {
	fromRpc(event: unknown): SessionDriverEvent | null;
}

/**
 * Maps an `AgentSessionEvent` from `omp --mode rpc` onto one of the
 * `SessionDriverEvent` variants the renderer consumes.
 *
 * The sidecar streams the agent-core `AgentEvent` union (plus a few
 * AgentSession extensions). We handle the three flows that matter for the
 * renderer contract:
 *
 *   message_update (assistantMessageEvent.type=text_delta) → assistantDelta
 *   tool_execution_start                                   → toolStarted
 *   tool_execution_update                                  → toolUpdated
 *   tool_execution_end                                     → toolFinished
 *
 * Other event types (turn_start/end, agent_start/end, auto_compaction_*,
 * auto_retry_*, thinking_delta, etc.) are returned as `null` — handled
 * elsewhere (e.g. `agent_end` drives `runCompleted` emission from the
 * connection) or not yet surfaced to the renderer.
 */
export function mapRpcEventToSessionEvent(
	event: RpcAgentSessionEvent,
	sessionRef: SessionRef,
	timestamp: string,
	runId?: string,
): SessionDriverEvent | null {
	const base = { sessionRef, timestamp, runId };

	if (event.type === "message_update") {
		const ame = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
		if (ame && ame.type === "text_delta" && typeof ame.delta === "string" && ame.delta.length > 0) {
			const out: AssistantDeltaEvent = { ...base, type: "assistantDelta", text: ame.delta };
			return out;
		}
		return null;
	}

	if (event.type === "tool_execution_start") {
		const e = event as { toolCallId?: string; toolName?: string; args?: unknown };
		if (!e.toolCallId) return null;
		const out: ToolStartedEvent = {
			...base,
			type: "toolStarted",
			toolName: e.toolName ?? "tool",
			callId: e.toolCallId,
			input: e.args,
		};
		return out;
	}

	if (event.type === "tool_execution_update") {
		const e = event as { toolCallId?: string; partialResult?: unknown };
		if (!e.toolCallId) return null;
		const text = typeof e.partialResult === "string" ? e.partialResult : undefined;
		const out: ToolUpdatedEvent = {
			...base,
			type: "toolUpdated",
			callId: e.toolCallId,
			text,
		};
		return out;
	}

	if (event.type === "tool_execution_end") {
		const e = event as { toolCallId?: string; result?: unknown; isError?: boolean };
		if (!e.toolCallId) return null;
		const out: ToolFinishedEvent = {
			...base,
			type: "toolFinished",
			callId: e.toolCallId,
			success: !e.isError,
			output: e.result,
		};
		return out;
	}

	return null;
}

/**
 * Maps `RpcExtensionErrorEvent` to the renderer's
 * `extensionCompatibilityIssue` event. RPC mode emits these when an
 * extension handler throws.
 */
export function mapRpcExtensionErrorToSessionEvent(
	event: RpcExtensionErrorEvent,
	sessionRef: SessionRef,
	timestamp: string,
	runId?: string,
): ExtensionCompatibilityIssueEvent {
	return {
		type: "extensionCompatibilityIssue",
		sessionRef,
		timestamp,
		runId,
		issue: {
			capability: event.event ?? "unknown",
			classification: "terminal-only",
			message: event.error,
			extensionPath: event.extensionPath,
			eventName: event.event,
		},
	};
}

export interface ExtensionUiRequestMapping {
	event: HostUiRequestEvent;
	/** Echoed in the `RpcExtensionUIResponse` so the sidecar can correlate. */
	extensionUiRequestId: string;
	method: RpcExtensionUIRequest["method"];
}

/**
 * Maps an `RpcExtensionUIRequest` onto a renderer-facing
 * `HostUiRequestEvent`. The caller must remember the sidecar's
 * `extensionUiRequestId` so the eventual `respondToHostUiRequest` can be
 * marshalled back into an `RpcExtensionUIResponse` with the same id.
 */
export function mapRpcExtensionUiRequestToHostUiRequest(
	request: RpcExtensionUIRequest,
	sessionRef: SessionRef,
	timestamp: string,
	requestId: string,
	runId?: string,
): ExtensionUiRequestMapping {
	let hostRequest: HostUiRequest;
	switch (request.method) {
		case "select":
			hostRequest = {
				kind: "select",
				requestId,
				title: request.title,
				options: request.options,
				allowMultiple: false,
				timeoutMs: request.timeout,
			};
			break;
		case "confirm":
			hostRequest = {
				kind: "confirm",
				requestId,
				title: request.title,
				message: request.message,
				timeoutMs: request.timeout,
			};
			break;
		case "input":
			hostRequest = {
				kind: "input",
				requestId,
				title: request.title,
				placeholder: request.placeholder,
				timeoutMs: request.timeout,
			};
			break;
		case "editor":
			hostRequest = {
				kind: "editor",
				requestId,
				title: request.title,
				initialValue: request.prefill,
			};
			break;
		case "notify":
			hostRequest = {
				kind: "notify",
				requestId,
				message: request.message,
				level: request.notifyType,
			};
			break;
		case "setStatus":
			hostRequest = {
				kind: "status",
				requestId,
				key: request.statusKey,
				text: request.statusText,
			};
			break;
		case "setWidget":
			hostRequest = {
				kind: "widget",
				requestId,
				key: request.widgetKey,
				lines: request.widgetLines,
				placement: request.widgetPlacement === "aboveEditor" ? "aboveComposer" : "belowComposer",
			};
			break;
		case "setTitle":
			hostRequest = { kind: "title", requestId, title: request.title };
			break;
		case "set_editor_text":
			hostRequest = { kind: "editorText", requestId, text: request.text };
			break;
	}

	const event: HostUiRequestEvent = {
		type: "hostUiRequest",
		sessionRef,
		timestamp,
		runId,
		request: hostRequest,
	};
	return { event, extensionUiRequestId: request.id, method: request.method };
}

/**
 * Updates a cached `SessionSnapshot` with a new title (rename) or
 * refreshed timestamp.
 */
export function mergeSnapshotUpdate(
	current: SessionSnapshot,
	patch: { title?: string; updatedAt?: string },
): SessionSnapshot {
	return {
		...current,
		title: patch.title ?? current.title,
		updatedAt: patch.updatedAt ?? current.updatedAt,
	};
}

/**
 * Builds a `sessionUpdated` event carrying a refreshed snapshot.
 */
export function makeSessionUpdatedEvent(snapshot: SessionSnapshot, runId?: string): SessionUpdatedEvent {
	return {
		type: "sessionUpdated",
		sessionRef: snapshot.ref,
		timestamp: snapshot.updatedAt,
		runId,
		snapshot,
	};
}

/**
 * Cached shape for slash commands surfaced via `get_commands` — consumed by
 * the session-driver shim's `getSessionCommands` implementation.
 */
export type CachedAvailableCommand = {
	readonly name: string;
	readonly description?: string;
	readonly [key: string]: unknown;
};
