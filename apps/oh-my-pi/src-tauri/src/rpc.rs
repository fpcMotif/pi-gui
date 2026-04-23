// ACP (Agent Client Protocol) client — Rust side.
//
// Consumes the `omp` sidecar's ACP output via the `agent-client-protocol`
// crate (crates.io: https://crates.io/crates/agent-client-protocol), maps
// ACP SessionUpdate variants to Tauri events the renderer can listen for,
// and exposes `tauri::command`s for the renderer to invoke the Agent side
// of ACP (newSession, prompt, cancel, loadSession, …).
//
// Scaffold scope (Slice 3b): typed shell + event enum sketch. The
// TypeScript-side `packages/oh-my-pi-acp-client` is the reference
// implementation — mirror its mapping decisions when fleshing this out:
//   - ACP `session_update/agent_message_chunk` → `session:assistantDelta`
//   - ACP `session_update/tool_call`           → `session:toolStarted`
//   - ACP `session_update/tool_call_update`    → `session:toolUpdated|toolFinished`
//   - ACP `requestPermission`                  → `session:hostUiRequest`
//   - ACP `newSession` response                → `session:sessionOpened`
//   - ACP `prompt` response                    → `session:runCompleted|runFailed`
//   - Local synth on dispose                   → `session:sessionClosed`

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
// - Wrap `agent_client_protocol::ClientSideConnection`.
// - Implement `agent_client_protocol::Client` trait:
//     fn session_update(&self, params: SessionNotification) -> Result<()>
//     fn request_permission(&self, params: ...) -> Result<...>
// - Fan-out per-session listeners (Tauri event emit) via an `Arc<RwLock<HashMap<SessionId, Vec<Channel>>>>`.
// - Expose tauri::command wrappers for:
//     start_session(workspace_ref, options) -> SessionSnapshot
//     send_prompt(session_ref, input) -> ()
//     cancel_run(session_ref) -> ()
//     respond_to_host_ui_request(session_ref, response) -> ()
//     close_session(session_ref) -> ()
