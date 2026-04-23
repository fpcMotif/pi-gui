/**
 * Tauri-side bridge adapter: maps `@tauri-apps/api` invoke/event onto the
 * shape the existing `apps/desktop/src/*` renderer expects on
 * `window.piApp` (defined by `apps/desktop/electron/preload.ts`).
 *
 * Goal: minimize renderer changes during the Tauri port. Once every IPC
 * channel in `apps/desktop/src/ipc.ts` has a Tauri counterpart registered
 * on the Rust side, we can copy the Electron renderer over wholesale.
 *
 * Status: bootstrap stub. The invoke/event wiring below is the pattern;
 * expand per IPC channel as the Rust host registers each `tauri::command`.
 */

type TauriInvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type TauriListenFn = <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;

async function loadTauri(): Promise<{ invoke: TauriInvokeFn; listen: TauriListenFn }> {
	// Dynamic import so the renderer can run in a plain browser for Vite dev/
	// preview without throwing when the Tauri runtime isn't injected.
	const coreMod = (await import("@tauri-apps/api/core")) as { invoke: TauriInvokeFn };
	const eventMod = (await import("@tauri-apps/api/event")) as {
		listen: <T>(event: string, handler: (evt: { payload: T }) => void) => Promise<() => void>;
	};
	const listen: TauriListenFn = async <T>(event: string, handler: (payload: T) => void) => {
		const unlisten = await eventMod.listen<T>(event, wrapped => handler(wrapped.payload));
		return unlisten;
	};
	return { invoke: coreMod.invoke, listen };
}

export async function bootstrapTauriApi(): Promise<void> {
	if (typeof window === "undefined") return;
	if (!("__TAURI_INTERNALS__" in window)) {
		console.warn("[oh-my-pi] Tauri runtime not detected; bridge adapter is a no-op.");
		return;
	}
	const { invoke, listen } = await loadTauri();

	// TODO (Slice 3c): implement the full `PiDesktopApi` surface here, mapping
	// each of the ~40 channels in apps/desktop/src/ipc.ts to its Tauri command
	// (`invoke("channel_name", { ... })`) and each event subscription to
	// `listen("channel_name", handler)`.
	//
	// Starter: just prove the bridge reaches the Rust host.
	try {
		const pong = await invoke<string>("ping");
		console.log("[oh-my-pi] tauri ping:", pong);
	} catch (err) {
		console.error("[oh-my-pi] tauri ping failed", err);
	}

	// Example event subscription (sidecar status, added in src-tauri/src/sidecar.rs):
	await listen<{ status: string }>("sidecar:status", payload => {
		console.log("[oh-my-pi] sidecar status:", payload.status);
	});
}
