// Sidecar management: spawn the bundled `omp` binary in `--mode rpc`,
// expose its stdio as async readable/writable halves suitable for feeding
// into the RPC client in `rpc.rs`.
//
// Scaffold scope: typed shell; real implementation wires Tauri's `Shell`
// plugin to a line-oriented NDJSON reader over the child's stdout and a
// JSON writer over stdin. The NodeJS-side wrapper in
// packages/oh-my-pi-rpc-client is the reference implementation for the
// protocol framing and id correlation; its sibling
// packages/oh-my-pi-acp-client remains in the tree as a fallback
// (`--mode acp`) until the RPC path proves out end-to-end.

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
// 2. Spawn it with `--mode rpc` plus `--no-session` if we manage persistence.
// 3. Feed its stdin/stdout into the RPC NDJSON reader/writer (see rpc.rs).
// 4. Emit `sidecar:status` events to the renderer.
// 5. Respawn on crash with backoff, queue outgoing RPCs during downtime.
