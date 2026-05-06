// RPC client — Rust side.
//
// Consumes the `omp` sidecar's native `--mode rpc` NDJSON stream
// (github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/modes/rpc),
// correlates command/response pairs by `id`, and fans AgentSessionEvent
// updates out to the renderer as Tauri events.
//
// Scaffold scope: typed event enum + future command surface. The
// TypeScript-side `packages/oh-my-pi-rpc-client` is the reference
// implementation — mirror its mapping decisions when fleshing this out:
//   - RPC `message_update(assistantMessageEvent: text_delta)` → `session:assistantDelta`
//   - RPC `tool_execution_start`                              → `session:toolStarted`
//   - RPC `tool_execution_update`                             → `session:toolUpdated`
//   - RPC `tool_execution_end`                                → `session:toolFinished`
//   - RPC `extension_ui_request`                              → `session:hostUiRequest`
//   - RPC `new_session` response + subsequent `get_state`     → `session:sessionOpened`
//   - RPC `agent_end` event                                   → `session:runCompleted|runFailed`
//   - Local synth on dispose / stream close                   → `session:sessionClosed`

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
	SessionOpened { session_id: String, title: String },
	SessionUpdated { session_id: String, title: String },
	SessionClosed { session_id: String, reason: String },
	AssistantDelta { session_id: String, text: String },
	ToolStarted { session_id: String, call_id: String, tool_name: String },
	ToolUpdated { session_id: String, call_id: String, text: Option<String> },
	ToolFinished { session_id: String, call_id: String, success: bool },
	RunCompleted { session_id: String },
	RunFailed { session_id: String, message: String },
	HostUiRequest { session_id: String, request_id: String, kind: String, title: String },
}

// TODO (later slice):
// - Build an NDJSON line reader over the sidecar's stdout and a JSON
//   writer over stdin (e.g. `tokio::io::BufReader::lines` + a mpsc
//   channel feeding stdin writes).
// - Maintain a `HashMap<String, oneshot::Sender<RpcResponse>>` keyed by
//   outgoing command id for response correlation.
// - Dispatch inbound messages by `type`:
//     "response"              -> resolve pending id
//     "ready"                 -> complete the initialization oneshot
//     "extension_ui_request"  -> emit `session:hostUiRequest`, retain id
//     "extension_error"       -> emit `session:extensionCompatibilityIssue`
//     AgentSessionEvent.type  -> mapRpcEventToSessionEvent (see TS ref)
// - Fan-out per-session listeners (Tauri event emit) via an
//   `Arc<RwLock<HashMap<SessionId, Vec<Channel>>>>`.
// - Expose tauri::command wrappers for:
//     start_session(workspace_ref, options) -> SessionSnapshot
//     send_prompt(session_ref, input) -> ()
//     cancel_run(session_ref) -> ()
//     respond_to_host_ui_request(session_ref, response) -> ()
//     close_session(session_ref) -> ()
