// Node-runnable smoke test for @pi-gui/oh-my-pi-rpc-client.
//
// Goal: prove the wrapper can spawn `omp --mode rpc`, receive the
// `ready` event, round-trip a get_state command over NDJSON, and clean
// up — without requiring configured provider credentials.
//
// Full end-to-end (new_session + prompt + streaming) needs `omp login`
// (or provider env vars like OPENAI_API_KEY). The handshake + get_state
// path is enough to verify:
//   (a) binary spawns
//   (b) NDJSON line reader parses stdout correctly
//   (c) command → response id correlation round-trips
// That's the smoke-test bar.
//
// Run under Node (not Bun). RPC uses raw Node Readable/Writable —
// there's no Web-stream adapter in the hot path, so the Bun-on-Windows
// handshake hang that tripped ACP does not apply here. Node is kept as
// the runner for parity with the ACP smoke and because Node is the
// actual target (Electron main / Tauri-spawned subprocess).
//
// Run:
//   pnpm --filter @pi-gui/oh-my-pi-rpc-client run build
//   pnpm --filter @pi-gui/oh-my-pi-rpc-client run smoke
//
// Env:
//   OMP_BIN — path to the compiled `omp` binary. Defaults to "omp" on PATH.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnOmpSidecar } from "../dist/index.js";

const READY_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10_000;

function readNdjson(stream, onMessage) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", chunk => {
		buffer += chunk;
		let i = buffer.indexOf("\n");
		while (i !== -1) {
			const line = buffer.slice(0, i).trim();
			buffer = buffer.slice(i + 1);
			if (line.length > 0) {
				try {
					onMessage(JSON.parse(line));
				} catch (err) {
					process.stderr.write(`[smoke] bad JSON line: ${line.slice(0, 120)}\n`);
				}
			}
			i = buffer.indexOf("\n");
		}
	});
}

async function main() {
	const workdir = await mkdtemp(join(tmpdir(), "omp-rpc-smoke-"));
	console.log(`[smoke] workdir=${workdir}`);

	const startSpawn = performance.now();
	const sidecar = spawnOmpSidecar({
		ompBinaryPath: process.env.OMP_BIN ?? "omp",
		cwd: workdir,
		extraArgs: ["--no-session", "--no-skills", "--no-extensions", "--no-rules", "--no-title"],
	});
	sidecar.process.stderr.on("data", c => process.stderr.write(`[omp stderr] ${c.toString()}`));
	sidecar.process.on("exit", (c, s) => console.log(`[smoke] omp exited code=${c} signal=${s}`));

	let ok = false;
	const pending = new Map();
	let readyResolve;
	let readyReject;
	const readyPromise = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const readyTimer = setTimeout(
		() => readyReject(new Error(`did not see "ready" within ${READY_TIMEOUT_MS}ms`)),
		READY_TIMEOUT_MS,
	);

	readNdjson(sidecar.process.stdout, msg => {
		if (msg.type === "ready") {
			clearTimeout(readyTimer);
			readyResolve();
			return;
		}
		if (msg.type === "response" && msg.id && pending.has(msg.id)) {
			const { resolve, timer } = pending.get(msg.id);
			clearTimeout(timer);
			pending.delete(msg.id);
			resolve(msg);
			return;
		}
		// Everything else is an event — log the type at most.
		if (msg.type) {
			process.stdout.write(`[smoke] event type=${msg.type}\n`);
		}
	});

	function send(cmd) {
		const id = cmd.id ?? randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`command "${cmd.type}" timed out after ${COMMAND_TIMEOUT_MS}ms`));
			}, COMMAND_TIMEOUT_MS);
			pending.set(id, { resolve, timer });
			sidecar.process.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	try {
		console.log("[smoke] waiting for ready …");
		await readyPromise;
		const readyTime = performance.now() - startSpawn;
		console.log(`[smoke] ready OK in ${readyTime.toFixed(1)}ms`);

		console.log("[smoke] get_state …");
		const stateStart = performance.now();
		const stateRes = await send({ type: "get_state" });
		const stateTime = performance.now() - stateStart;
		if (!stateRes.success) {
			throw new Error(`get_state failed: ${stateRes.error}`);
		}
		console.log(
			`[smoke] get_state OK in ${stateTime.toFixed(1)}ms — sessionId=${stateRes.data?.sessionId} thinking=${stateRes.data?.thinkingLevel} streaming=${stateRes.data?.isStreaming}`,
		);

		ok = true;
	} catch (err) {
		console.error("[smoke] ERROR", err);
		process.exitCode = 1;
	} finally {
		console.log("[smoke] dispose …");
		const disposeStart = performance.now();
		await sidecar.stop();
		const disposeTime = performance.now() - disposeStart;
		console.log(`[smoke] sidecar stopped in ${disposeTime.toFixed(1)}ms`);
		await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
		if (ok) {
			console.log(
				"[smoke] OK — handshake + get_state round-trip succeeded. Full end-to-end (new_session + prompt + streaming) requires `omp login` or provider API-key env vars; that's out of scope for this smoke.",
			);
		}
	}
}

main().catch(err => {
	console.error("[smoke] fatal", err);
	process.exit(1);
});
