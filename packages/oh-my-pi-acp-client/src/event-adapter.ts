import type {
	AssistantDeltaEvent,
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

export interface AcpEventAdapter {
	fromAcp(acpEvent: unknown): SessionDriverEvent | null;
}

type AcpContentBlock = { type?: string; text?: string };
type AcpContentChunk = { content?: AcpContentBlock };
type AcpToolCall = {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	content?: unknown;
	rawInput?: unknown;
	rawOutput?: unknown;
};
type AcpToolCallUpdate = AcpToolCall;
type AcpSessionUpdateEnvelope = { sessionUpdate: string } & Record<string, unknown>;

/**
 * Extracts plain text from an ACP ContentChunk's `content` block, concatenating
 * any text segments. Non-text blocks (images, resource refs) are ignored for the
 * streaming delta path — those surface separately as attachments on completed
 * messages.
 */
function extractDeltaText(update: AcpContentChunk): string {
	const block = update.content;
	if (!block || typeof block !== "object") return "";
	if (block.type === "text" && typeof block.text === "string") {
		return block.text;
	}
	return "";
}

/**
 * Maps an ACP `SessionUpdate` envelope onto one of the 11 `SessionDriverEvent`
 * variants where a clean 1:1 exists.
 *
 * Covered in this slice (1b):
 *   agent_message_chunk   → assistantDelta
 *   tool_call             → toolStarted
 *   tool_call_update      → toolUpdated | toolFinished (by status)
 *
 * Deferred to Slice 1c:
 *   sessionOpened / sessionUpdated / runCompleted / runFailed (lifecycle)
 *   hostUiRequest (from requestPermission + unstable_createElicitation)
 *   extensionCompatibilityIssue (synth'd if renderer needs it)
 *   sessionClosed (emitted locally on disposal)
 *   agent_thought_chunk / plan / usage_update (not yet consumed by renderer)
 */
export function mapAcpUpdateToSessionEvent(
	update: AcpSessionUpdateEnvelope,
	sessionRef: SessionRef,
	timestamp: string,
	runId?: string,
): SessionDriverEvent | null {
	const base = { sessionRef, timestamp, runId };
	const kind = update.sessionUpdate;

	if (kind === "agent_message_chunk") {
		const text = extractDeltaText(update as AcpContentChunk);
		if (!text) return null;
		const event: AssistantDeltaEvent = { ...base, type: "assistantDelta", text };
		return event;
	}

	if (kind === "tool_call") {
		const call = update as unknown as AcpToolCall;
		const event: ToolStartedEvent = {
			...base,
			type: "toolStarted",
			// ACP `title` is the human-readable name of the call (e.g. "Read file
			// src/foo.ts"); `kind` is a UX-hint enum ("read" | "edit" | …). Prefer
			// `title` for display; fall back to `kind` if the agent omits title.
			toolName: call.title ?? call.kind ?? "tool",
			callId: call.toolCallId,
			input: call.rawInput,
		};
		return event;
	}

	if (kind === "tool_call_update") {
		const call = update as unknown as AcpToolCallUpdate;
		if (call.status === "completed" || call.status === "failed") {
			const event: ToolFinishedEvent = {
				...base,
				type: "toolFinished",
				callId: call.toolCallId,
				success: call.status === "completed",
				// Only `rawOutput` is the agent's raw tool return value. `content` is
				// a structured UX payload (diff / terminal blocks) with a different
				// shape and should not masquerade as tool output here.
				output: call.rawOutput,
			};
			return event;
		}
		const event: ToolUpdatedEvent = {
			...base,
			type: "toolUpdated",
			callId: call.toolCallId,
			text: call.title,
		};
		return event;
	}

	return null;
}

type AcpPermissionOption = { optionId: string; name: string; kind: string };
type AcpRequestPermissionRequest = {
	sessionId: string;
	options: AcpPermissionOption[];
	toolCall: { title?: string; toolCallId: string };
};

export interface PermissionMapping {
	event: HostUiRequestEvent;
	optionIdByLabel: Map<string, string>;
	/** optionId for the first `allow_*` option, if any — used by the confirm-shortcut resolver. */
	allowOptionId?: string;
	/** optionId for the first `reject_*` option, if any — used by the confirm-shortcut resolver. */
	rejectOptionId?: string;
}

/**
 * Maps an ACP `RequestPermissionRequest` to a `HostUiRequestEvent`.
 *
 * ACP permissions carry a list of typed options (allow_once / allow_always /
 * reject_once / reject_always) with labels. Our `HostUiRequest` has:
 *   - `confirm` — simple yes/no (used when we can unambiguously detect a 2-option allow/reject pair)
 *   - `select`  — list of string labels (lossy fallback for everything else)
 *
 * The caller gets back a label→optionId map so the response from the renderer
 * (a string `value` per `HostUiResponse`) can be translated back into the ACP
 * `optionId` the agent expects.
 *
 * A dedicated `permission` kind on `HostUiRequest` would be cleaner long-term;
 * tracked in the plan's Slice 1d / renderer-port-to-ACP migration note.
 */
export function mapAcpPermissionToHostUiRequest(
	params: AcpRequestPermissionRequest,
	sessionRef: SessionRef,
	timestamp: string,
	requestId: string,
	runId?: string,
): PermissionMapping {
	const optionIdByLabel = new Map<string, string>();
	for (const option of params.options) {
		optionIdByLabel.set(option.name, option.optionId);
	}

	const allowOption = params.options.find(o => o.kind.startsWith("allow"));
	const rejectOption = params.options.find(o => o.kind.startsWith("reject"));
	// Only treat as a simple confirm when we have exactly one allow AND one reject.
	// Two allow variants (allow_once + allow_always) or two reject variants must fall
	// back to `select` so the user sees the real choices.
	const isSimpleConfirm = params.options.length === 2 && !!allowOption && !!rejectOption;

	const title = params.toolCall.title ?? "Tool permission requested";
	let request: HostUiRequest;
	if (isSimpleConfirm) {
		request = {
			kind: "confirm",
			requestId,
			title,
			message: `The agent wants to ${allowOption?.name.toLowerCase() ?? "proceed"}.`,
			defaultValue: false,
		};
	} else {
		request = {
			kind: "select",
			requestId,
			title,
			options: params.options.map(o => o.name),
			allowMultiple: false,
		};
	}

	const event: HostUiRequestEvent = {
		type: "hostUiRequest",
		sessionRef,
		timestamp,
		runId,
		request,
	};
	return {
		event,
		optionIdByLabel,
		allowOptionId: allowOption?.optionId,
		rejectOptionId: rejectOption?.optionId,
	};
}

type AcpSessionInfoUpdate = { title?: string | null; updatedAt?: string | null };

/**
 * Merges an ACP `session_info_update` into a cached `SessionSnapshot`.
 *
 * ACP sends only the fields that changed (null = clear, undefined = unchanged).
 * This mirrors that semantics into our snapshot: null clears where the shape
 * allows, undefined leaves the current value intact.
 */
export function mergeAcpSessionInfoUpdate(current: SessionSnapshot, update: AcpSessionInfoUpdate): SessionSnapshot {
	const updatedAt = update.updatedAt ?? current.updatedAt;
	let title = current.title;
	if (update.title === null) title = "";
	else if (typeof update.title === "string") title = update.title;
	return { ...current, title, updatedAt };
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
 * ACP `AvailableCommand` shape, cached by `acp-connection` for the shim's
 * future `getSessionCommands` implementation. Keep loose-typed here so a minor
 * ACP schema bump (added fields) doesn't force a shim-level change.
 */
export type CachedAvailableCommand = {
	readonly name: string;
	readonly description?: string;
	readonly [key: string]: unknown;
};
