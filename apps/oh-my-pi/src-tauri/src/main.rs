// Tauri app entry for oh-my-pi.
//
// Scaffold scope (Slice 3b): declare the plugins we need, register a
// single `ping` command to prove the frontend↔Rust bridge, and stub out
// the sidecar-spawn hook. The real ACP client wire lives in `sidecar.rs`
// and `rpc.rs` and gets wired up in later slices.
//
// NOT yet compile-verified — requires rustup + MSVC (or GNU) toolchain.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod rpc;
mod sidecar;

#[tauri::command]
fn ping() -> &'static str {
	"pong"
}

fn main() {
	tracing_subscriber::fmt()
		.with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
		.init();

	tauri::Builder::default()
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_clipboard_manager::init())
		.plugin(tauri_plugin_deep_link::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.invoke_handler(tauri::generate_handler![ping])
		.setup(|app| {
			// TODO (later slice): spawn `omp --mode acp` via sidecar::spawn, wire its
			// stdio into rpc::AcpClient, and expose per-channel tauri::commands for
			// the renderer's SessionDriver surface.
			let _ = app;
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
