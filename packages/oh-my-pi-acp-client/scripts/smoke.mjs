// Node-runnable ACP handshake smoke test for @pi-gui/oh-my-pi-acp-client.
//
// Goal: prove the wrapper can spawn `omp --mode acp`, complete the ACP
// `initialize` handshake, and clean up — without requiring configured
// provider credentials.
//
// Full end-to-end (newSession + prompt + streaming) needs `omp login`
// (or provider env vars like OPENAI_API_KEY) because oh-my-pi validates
// auth before answering `newSession`. The handshake alone is enough to
// verify: (a) binary spawns, (b) our Node→Web stream wrapping works with
// ACP's `ndJsonStream`, (c) ClientSideConnection + ACP JSON-RPC framing
// round-trips. That's the smoke-test bar.
//
// Why Node (not Bun)?
//   Bun on Windows doesn't flush bytes through `Writable.toWeb` in a way
//   ACP's stream framing needs (handshake hangs). Node works. Node is
//   the actual target (Electron main / Tauri-spawned subprocess), so this
//   is a "run smoke on Node" note, not a product concern.
//
// Run:
//   pnpm --filter @pi-gui/oh-my-pi-acp-client run build
//   pnpm --filter @pi-gui/oh-my-pi-acp-client run smoke

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOmpSidecar } from "../dist/index.js";

const TIMEOUT_MS = 15000;

async function main() {
	const workdir = await mkdtemp(join(tmpdir(), "omp-smoke-"));
	console.log(`[smoke] workdir=${workdir}`);

	const sidecar = spawnOmpSidecar({
		ompBinaryPath: process.env.OMP_BIN ?? "omp",
		cwd: workdir,
		extraArgs: ["--no-session", "--no-skills", "--no-extensions", "--no-rules", "--no-title"],
	});
	sidecar.process.stderr.on("data", c => process.stderr.write(`[omp stderr] ${c.toString()}`));
	sidecar.process.on("exit", (c, s) => console.log(`[smoke] omp exited code=${c} signal=${s}`));

	let ok = false;
	try {
		const sdk = await import("@agentclientprotocol/sdk");
		const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = sdk;
		const { output, input } = sidecar.webStreams();
		const stream = ndJsonStream(output, input);
		const conn = new ClientSideConnection(
			() => ({
				async sessionUpdate() {},
				async requestPermission() {
					return { outcome: { outcome: "cancelled" } };
				},
			}),
			stream,
		);

		console.log("[smoke] initialize …");
		const initRes = await Promise.race([
			conn.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			}),
			new Promise((_, rej) => setTimeout(() => rej(new Error("initialize timeout")), TIMEOUT_MS)),
		]);
		console.log(
			`[smoke] initialize OK — agent=${initRes.agentInfo?.name} v${initRes.agentInfo?.version} protocol=${initRes.protocolVersion}`,
		);
		console.log(`[smoke] auth methods: ${initRes.authMethods?.map(m => m.id).join(", ") ?? "none"}`);
		console.log(
			`[smoke] agent capabilities: loadSession=${initRes.agentCapabilities?.loadSession}, session.list=${!!initRes.agentCapabilities?.sessionCapabilities?.list}, session.resume=${!!initRes.agentCapabilities?.sessionCapabilities?.resume}`,
		);
		ok = true;
	} catch (err) {
		console.error("[smoke] ERROR", err);
		process.exitCode = 1;
	} finally {
		console.log("[smoke] dispose …");
		await sidecar.stop();
		await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
		if (ok) {
			console.log(
				"[smoke] OK — handshake succeeded. Full end-to-end (newSession + prompt + streaming) requires `omp login` or provider API-key env vars; that's out of scope for this smoke.",
			);
		}
	}
}

main().catch(err => {
	console.error("[smoke] fatal", err);
	process.exit(1);
});
