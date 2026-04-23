export { spawnOmpSidecar, type OmpSidecarHandle, type OmpSidecarOptions } from "./sidecar-process.js";
export {
	AcpShimUnsupportedError,
	createAcpSessionDriverShim,
	type AcpSessionDriverShim,
} from "./session-driver-shim.js";
export {
	makeSessionUpdatedEvent,
	mapAcpPermissionToHostUiRequest,
	mapAcpUpdateToSessionEvent,
	mergeAcpSessionInfoUpdate,
	type AcpEventAdapter,
	type CachedAvailableCommand,
	type PermissionMapping,
} from "./event-adapter.js";
export { createAcpConnection, type AcpConnection, type AcpSessionEventListener } from "./acp-connection.js";
