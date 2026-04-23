import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

export interface OmpSidecarOptions {
	ompBinaryPath: string;
	cwd: string;
	/**
	 * Env to inherit into the sidecar. If omitted, a minimal whitelist is used
	 * (PATH, HOME / USERPROFILE, TMPDIR / TEMP / TMP, LANG, OMP_*) so the host's
	 * OAuth tokens and unrelated env vars don't leak to the child agent.
	 * Pass `process.env` explicitly to restore full inheritance.
	 */
	env?: NodeJS.ProcessEnv;
	extraArgs?: string[];
}

export interface OmpSidecarHandle {
	process: ChildProcessWithoutNullStreams;
	stop: () => Promise<void>;
	webStreams: () => { output: WritableStream<Uint8Array>; input: ReadableStream<Uint8Array> };
}

const ENV_ALLOWLIST = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];

function filteredEnv(): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) out[key] = value;
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("OMP_") && value !== undefined) out[key] = value;
	}
	return out;
}

export function spawnOmpSidecar(options: OmpSidecarOptions): OmpSidecarHandle {
	const args = ["--mode", "acp", ...(options.extraArgs ?? [])];
	const child: ChildProcessWithoutNullStreams = spawn(options.ompBinaryPath, args, {
		cwd: options.cwd,
		env: options.env ?? filteredEnv(),
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stopped = false;
	const stop = async () => {
		if (stopped || child.exitCode !== null) {
			stopped = true;
			return;
		}
		stopped = true;
		// Register exit listener BEFORE sending SIGTERM to avoid a race where the
		// process exits between `child.exitCode` check and `.once("exit")`.
		const exited = new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		try {
			child.kill("SIGTERM");
		} catch {
			// Ignore ESRCH / EPERM — child may already be gone.
		}
		await exited;
	};

	// Memoize: `Writable.toWeb` / `Readable.toWeb` transfer ownership of the
	// underlying Node stream to the Web wrapper, so calling them twice on the
	// same child's stdio produces a second wrapper that contends with the first.
	let streamsCached: { output: WritableStream<Uint8Array>; input: ReadableStream<Uint8Array> } | undefined;
	const webStreams = () => {
		if (!streamsCached) {
			streamsCached = {
				output: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
				input: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
			};
		}
		return streamsCached;
	};

	return { process: child, stop, webStreams };
}
