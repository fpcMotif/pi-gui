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
import type { AcpConnection } from "./acp-connection.js";

/**
 * Partial `SessionDriver` adapter backed by an ACP connection to the oh-my-pi
 * coding agent. The shim is the *consumer-facing* API the existing renderer
 * will import as a drop-in replacement for `packages/pi-sdk-driver`.
 *
 * Mapping status:
 *
 *   supported   | createSession, sendUserMessage, cancelCurrentRun, closeSession,
 *               | subscribe, respondToHostUiRequest, renameSession (local),
 *               | openSession (from cache), getSessionCommands (from cached
 *               | availableCommands)
 *
 *   unsupported | archiveSession, unarchiveSession, setSessionModel,
 *               | setSessionThinkingLevel, compactSession, reloadSession,
 *               | getSessionTree, navigateSessionTree, replaceQueuedMessages
 *
 * Unsupported methods throw `AcpShimUnsupportedError`. The renderer should
 * catch these at call sites that now surface them (typically around the
 * model-switcher / compact / session-tree UI affordances) and either disable
 * those affordances or degrade gracefully.
 *
 * The correct long-term fix is the Option-2 migration documented in the plan —
 * port the renderer to consume ACP events directly, at which point most of the
 * unsupported surface either has an ACP equivalent or gets dropped from the UI.
 *
 * Archive/unarchive note: ACP has no notion of archived sessions. Rather than
 * silently storing flags the renderer can't observe (dead state), we throw
 * from archive/unarchive so the caller knows to gate those UI controls.
 */
export class AcpShimUnsupportedError extends Error {
	constructor(method: string) {
		super(`${method} is not supported by @pi-gui/oh-my-pi-acp-client (ACP wrapper).`);
		this.name = "AcpShimUnsupportedError";
	}
}

export interface AcpSessionDriverShim extends SessionDriver {
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

export function createAcpSessionDriverShim(connection: AcpConnection): AcpSessionDriverShim {
	return {
		async createSession(ws: WorkspaceRef, options?: CreateSessionOptions): Promise<SessionSnapshot> {
			return connection.startSession(ws, options);
		},
		async openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
			const cached = connection.getSnapshot(sessionRef);
			if (!cached) {
				throw new AcpShimUnsupportedError(
					"openSession (ACP loadSession not yet wired — see plan Slice 1e)",
				);
			}
			return cached;
		},
		async archiveSession(_sessionRef: SessionRef): Promise<void> {
			throw new AcpShimUnsupportedError("archiveSession (ACP has no archive concept)");
		},
		async unarchiveSession(_sessionRef: SessionRef): Promise<void> {
			throw new AcpShimUnsupportedError("unarchiveSession (ACP has no archive concept)");
		},
		async sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
			await connection.sendPrompt(sessionRef, input);
		},
		async replaceQueuedMessages(_sessionRef: SessionRef, _messages: readonly SessionQueuedMessage[]): Promise<void> {
			throw new AcpShimUnsupportedError("replaceQueuedMessages (ACP has no client-side queue model)");
		},
		async cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
			await connection.cancelRun(sessionRef);
		},
		async setSessionModel(_sessionRef: SessionRef, _selection: SessionModelSelection): Promise<void> {
			throw new AcpShimUnsupportedError("setSessionModel (use ACP session/set_model; not yet mapped)");
		},
		async setSessionThinkingLevel(_sessionRef: SessionRef, _thinkingLevel: string): Promise<void> {
			throw new AcpShimUnsupportedError(
				"setSessionThinkingLevel (ACP sends thinking level as a session-config-option update)",
			);
		},
		async renameSession(sessionRef: SessionRef, title: string): Promise<void> {
			connection.renameSessionLocal(sessionRef, title);
		},
		async compactSession(_sessionRef: SessionRef, _customInstructions?: string): Promise<void> {
			throw new AcpShimUnsupportedError("compactSession (no ACP equivalent)");
		},
		async reloadSession(_sessionRef: SessionRef): Promise<void> {
			throw new AcpShimUnsupportedError("reloadSession (no ACP equivalent)");
		},
		async getSessionTree(_sessionRef: SessionRef): Promise<SessionTreeSnapshot> {
			throw new AcpShimUnsupportedError("getSessionTree (ACP has no session-tree concept)");
		},
		async navigateSessionTree(
			_sessionRef: SessionRef,
			_targetId: string,
			_options?: NavigateSessionTreeOptions,
		): Promise<NavigateSessionTreeResult> {
			throw new AcpShimUnsupportedError("navigateSessionTree (ACP has no session-tree concept)");
		},
		async getSessionCommands(sessionRef: SessionRef): Promise<readonly RuntimeCommandRecord[]> {
			return connection.getAvailableCommands(sessionRef).map(toRuntimeCommandRecord);
		},
		async respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse): Promise<void> {
			await connection.respondToHostUiRequest(sessionRef, response);
		},
		subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
			// `SessionEventListener` is already `(event) => void | Promise<void>`;
			// `AcpSessionEventListener` is `(event) => void`. Pass through — the
			// connection's emit loop doesn't await return values, so any Promise
			// the listener returns simply floats (matching prior SDK behavior).
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
