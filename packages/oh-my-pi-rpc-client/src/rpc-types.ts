/**
 * RPC protocol types for `omp --mode rpc`.
 *
 * Mirrors `packages/coding-agent/src/modes/rpc/rpc-types.ts` in the
 * oh-my-pi fork (github.com/can1357/oh-my-pi, 14.1.x). Also compatible
 * with the upstream `@mariozechner/pi-coding-agent@0.62` RPC surface
 * that is already present in `node_modules/` — the fork's surface is a
 * strict superset (adds host-tools, `set_todos`, `abort_and_prompt`,
 * `set_interrupt_mode`; renames `fork` → `branch`).
 *
 * Wire format: newline-delimited JSON.
 *  - Commands (host → sidecar): objects with `type` and optional `id`
 *    for response correlation. Written to sidecar stdin, one per line.
 *  - Responses (sidecar → host): `{type: "response", command, success, id?, data?, error?}`.
 *  - Events (sidecar → host): AgentSessionEvent and lifecycle events like
 *    `ready`, `extension_error`, `extension_ui_request`. Arrive interleaved
 *    with responses on the same stream.
 *
 * These types are deliberately typed loosely where the agent-core event
 * union is rich and evolves across versions — we only strong-type the
 * fields the renderer actually consumes (see `event-adapter.ts`).
 */

export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type SteeringMode = "all" | "one-at-a-time";
export type FollowUpMode = "all" | "one-at-a-time";
export type StreamingBehavior = "steer" | "followUp";

/** Loose image content — only the envelope matters to the host; the agent validates contents. */
export interface RpcImageContent {
	readonly mimeType: string;
	readonly data: string;
}

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: RpcImageContent[]; streamingBehavior?: StreamingBehavior }
	| { id?: string; type: "steer"; message: string; images?: RpcImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: RpcImageContent[] }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: RpcImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_todos"; todos: readonly unknown[] }
	| { id?: string; type: "set_host_tools"; tools: readonly RpcHostToolDefinition[] }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_steering_mode"; mode: SteeringMode }
	| { id?: string; type: "set_follow_up_mode"; mode: FollowUpMode }
	| { id?: string; type: "set_interrupt_mode"; mode: string }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

export interface RpcSessionState {
	readonly model?: unknown;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly steeringMode: SteeringMode;
	readonly followUpMode: FollowUpMode;
	readonly sessionFile?: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly autoCompactionEnabled: boolean;
	readonly messageCount: number;
	readonly pendingMessageCount: number;
}

/** A command available for invocation via prompt (slash commands). */
export interface RpcSlashCommand {
	readonly name: string;
	readonly description?: string;
	readonly source: "extension" | "prompt" | "skill";
	readonly sourceInfo: {
		readonly path: string;
		readonly source: string;
		readonly scope: "user" | "project" | "temporary";
		readonly origin: "package" | "top-level";
	};
}

export type RpcResponseSuccessData =
	| { readonly command: "get_state"; readonly data: RpcSessionState }
	| { readonly command: "get_commands"; readonly data: { readonly commands: readonly RpcSlashCommand[] } }
	| { readonly command: "get_last_assistant_text"; readonly data: { readonly text: string | null } }
	| { readonly command: "get_messages"; readonly data: { readonly messages: readonly unknown[] } }
	| { readonly command: "new_session"; readonly data: { readonly cancelled: boolean } }
	| { readonly command: string; readonly data?: unknown };

export type RpcResponse =
	| { readonly id?: string; readonly type: "response"; readonly command: string; readonly success: true; readonly data?: unknown }
	| { readonly id?: string; readonly type: "response"; readonly command: string; readonly success: false; readonly error: string };

/** Host-side tool protocol — the host declares tools the agent can call out to via RPC. */
export interface RpcHostToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: unknown;
}

export interface RpcHostToolCallRequest {
	readonly type: "host_tool_call";
	readonly id: string;
	readonly toolName: string;
	readonly args: unknown;
}

export interface RpcHostToolCancelRequest {
	readonly type: "host_tool_cancel";
	readonly id: string;
}

export type RpcHostToolUpdate = {
	readonly type: "host_tool_update";
	readonly id: string;
	readonly progress?: unknown;
};

export type RpcHostToolResult = {
	readonly type: "host_tool_result";
	readonly id: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
};

/** Extension UI request — forwarded from extensions via the agent. */
export type RpcExtensionUIRequest =
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "select"; readonly title: string; readonly options: readonly string[]; readonly timeout?: number }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "confirm"; readonly title: string; readonly message: string; readonly timeout?: number }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "input"; readonly title: string; readonly placeholder?: string; readonly timeout?: number }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "editor"; readonly title: string; readonly prefill?: string }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "notify"; readonly message: string; readonly notifyType?: "info" | "warning" | "error" }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "setStatus"; readonly statusKey: string; readonly statusText: string | undefined }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "setWidget"; readonly widgetKey: string; readonly widgetLines: readonly string[] | undefined; readonly widgetPlacement?: "aboveEditor" | "belowEditor" }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "setTitle"; readonly title: string }
	| { readonly type: "extension_ui_request"; readonly id: string; readonly method: "set_editor_text"; readonly text: string };

export type RpcExtensionUIResponse =
	| { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
	| { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
	| { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

/** Emitted once at startup when the sidecar is ready to accept commands. */
export interface RpcReadyEvent {
	readonly type: "ready";
}

/** Emitted when an extension event handler throws. */
export interface RpcExtensionErrorEvent {
	readonly type: "extension_error";
	readonly extensionPath?: string;
	readonly event?: string;
	readonly error: string;
}

/**
 * AgentSessionEvent as streamed by RPC mode. Typed loosely — we only
 * strong-type the discriminants and fields the renderer consumes. See
 * the agent-core `AgentEvent` union + AgentSession extensions for the
 * full shape. Downstream code narrows by `event.type` string and treats
 * unknown types as pass-throughs.
 */
export interface RpcAgentSessionEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** Every distinct shape that may arrive on the sidecar's stdout stream. */
export type RpcInboundMessage =
	| RpcResponse
	| RpcReadyEvent
	| RpcExtensionErrorEvent
	| RpcExtensionUIRequest
	| RpcHostToolCallRequest
	| RpcHostToolCancelRequest
	| RpcAgentSessionEvent;
