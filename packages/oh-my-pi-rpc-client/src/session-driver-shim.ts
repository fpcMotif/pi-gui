import type {
	CreateSessionOptions,
	HostUiResponse,
	NavigateSessionTreeOptions,
	NavigateSessionTreeResult,
	SessionDriver,
	SessionEventListener,
	SessionMessageInput,
	SessionModelSelection,
	SessionQueuedMessage,
	SessionRef,
	SessionSnapshot,
	SessionTreeSnapshot,
	Unsubscribe,
	WorkspaceRef,
} from "@pi-gui/session-driver";
import type { RuntimeCommandRecord } from "@pi-gui/session-driver/runtime-types";
import type { RpcConnection } from "./rpc-connection.js";

/**
 * Partial `SessionDriver` adapter backed by an RPC connection to the
 * oh-my-pi coding agent. Drop-in sibling of `AcpSessionDriverShim` —
 * same consumer-facing surface so renderers can swap without changes.
 *
 * Mapping status:
 *
 *   supported   | createSession, sendUserMessage, cancelCurrentRun, closeSession,
 *               | subscribe, respondToHostUiRequest, renameSession (local +
 *               | best-effort sidecar), openSession (from cache),
 *               | getSessionCommands (from cached get_commands)
 *
 *   unsupported | archiveSession, unarchiveSession, setSessionModel,
 *               | setSessionThinkingLevel, compactSession, reloadSession,
 *               | getSessionTree, navigateSessionTree, replaceQueuedMessages
 *
 * Most of the "unsupported" set has a direct RPC command
 * (`set_model`, `set_thinking_level`, `compact`, `branch`, `get_branch_messages`)
 * — wiring them up is tracked as follow-up work once the base transport
 * proves out. Meanwhile, unsupported methods throw `RpcShimUnsupportedError`
 * so callers can gate affordances (model switcher, compact, tree nav).
 */
export class RpcShimUnsupportedError extends Error {
	constructor(method: string) {
		super(`${method} is not supported by @pi-gui/oh-my-pi-rpc-client (RPC wrapper).`);
		this.name = "RpcShimUnsupportedError";
	}
}

export interface RpcSessionDriverShim extends SessionDriver {
	dispose(): Promise<void>;
}

function toRuntimeCommandRecord(cmd: { name: string; description?: string }): RuntimeCommandRecord {
	return {
		name: cmd.name,
		description: cmd.description,
		source: "prompt",
		sourceInfo: { path: "", source: "oh-my-pi", scope: "user", origin: "top-level" },
	};
}

export function createRpcSessionDriverShim(connection: RpcConnection): RpcSessionDriverShim {
	return {
		async createSession(ws: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
			return connection.startSession(ws, options);
		},
		async openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
			const cached = connection.getSnapshot(sessionRef);
			if (!cached) {
				throw new RpcShimUnsupportedError(
					"openSession (RPC `switch_session` not yet wired — follow-up after base transport lands)",
				);
			}
			return cached;
		},
		async archiveSession(_sessionRef: SessionRef): Promise<void> {
			throw new RpcShimUnsupportedError("archiveSession (RPC has no archive concept)");
		},
		async unarchiveSession(_sessionRef: SessionRef): Promise<void> {
			throw new RpcShimUnsupportedError("unarchiveSession (RPC has no archive concept)");
		},
		async sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
			await connection.sendPrompt(sessionRef, input);
		},
		async replaceQueuedMessages(_sessionRef: SessionRef, _messages: readonly SessionQueuedMessage[]): Promise<void> {
			throw new RpcShimUnsupportedError("replaceQueuedMessages (RPC has no client-side queue model)");
		},
		async cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
			await connection.cancelRun(sessionRef);
		},
		async setSessionModel(_sessionRef: SessionRef, _selection: SessionModelSelection): Promise<void> {
			throw new RpcShimUnsupportedError("setSessionModel (use RPC `set_model`; follow-up)");
		},
		async setSessionThinkingLevel(_sessionRef: SessionRef, _thinkingLevel: string): Promise<void> {
			throw new RpcShimUnsupportedError("setSessionThinkingLevel (use RPC `set_thinking_level`; follow-up)");
		},
		async renameSession(sessionRef: SessionRef, title: string): Promise<void> {
			connection.renameSessionLocal(sessionRef, title);
		},
		async compactSession(_sessionRef: SessionRef, _customInstructions?: string): Promise<void> {
			throw new RpcShimUnsupportedError("compactSession (use RPC `compact`; follow-up)");
		},
		async reloadSession(_sessionRef: SessionRef): Promise<void> {
			throw new RpcShimUnsupportedError("reloadSession (no RPC equivalent)");
		},
		async getSessionTree(_sessionRef: SessionRef): Promise<SessionTreeSnapshot> {
			throw new RpcShimUnsupportedError("getSessionTree (use RPC `get_branch_messages`; follow-up)");
		},
		async navigateSessionTree(
			_sessionRef: SessionRef,
			_targetId: string,
			_options?: NavigateSessionTreeOptions,
		): Promise<NavigateSessionTreeResult> {
			throw new RpcShimUnsupportedError("navigateSessionTree (use RPC `branch`; follow-up)");
		},
		async getSessionCommands(sessionRef: SessionRef): Promise<readonly RuntimeCommandRecord[]> {
			return connection.getAvailableCommands(sessionRef).map(toRuntimeCommandRecord);
		},
		async respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void> {
			await connection.respondToHostUiRequest(sessionRef, response);
		},
		subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
			return connection.subscribe(sessionRef, listener as (event: Parameters<SessionEventListener>[0]) => void);
		},
		async closeSession(sessionRef: SessionRef): Promise<void> {
			await connection.closeSession(sessionRef);
		},
		async dispose(): Promise<void> {
			await connection.dispose();
		},
	};
}
