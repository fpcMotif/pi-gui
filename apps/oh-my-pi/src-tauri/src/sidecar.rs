// Sidecar management: spawn the bundled `omp` binary in `--mode acp`,
// expose its stdio as async readable/writable halves suitable for feeding
// into the ACP Rust client in `rpc.rs`.
//
// Scaffold scope (Slice 3b): typed shell; real implementation wires
// Tauri's `Shell` plugin to an agent-client-protocol `AsyncReadWrite`
// stream. The NodeJS-side wrapper in packages/oh-my-pi-acp-client already
// verified the protocol works against this same binary.

use serde::Serialize;
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase", tag = "status")]
pub enum SidecarStatus {
	Starting,
	Ready,
	Crashed { code: Option<i32> },
	Stopped,
}

pub struct SidecarHandle {
	pub status: broadcast::Sender<SidecarStatus>,
	// TODO (later slice):
	// - tokio::process::Child for the spawned omp process
	// - tokio::io::AsyncWriteExt handle feeding stdin
	// - tokio::io::AsyncBufReadExt handle reading stdout
	// - reconnect/respawn policy (exponential backoff)
}

impl SidecarHandle {
	pub fn new() -> Arc<Self> {
		let (status, _) = broadcast::channel(16);
		Arc::new(Self { status })
	}
}

// TODO: pub fn spawn(app_handle: tauri::AppHandle, workspace_cwd: &Path)
//       -> Result<Arc<SidecarHandle>, SidecarError>
//
// Steps:
// 1. Resolve the bundled omp binary path via Tauri's shell sidecar API
//    (honours `bundle.externalBin` → `binaries/omp`).
// 2. Spawn it with `--mode acp` plus `--no-session` if we manage persistence.
// 3. Feed its stdin/stdout into agent-client-protocol's `ClientSideConnection`
//    (see rpc.rs).
// 4. Emit `sidecar:status` events to the renderer.
// 5. Respawn on crash with backoff, queue outgoing RPCs during downtime.
