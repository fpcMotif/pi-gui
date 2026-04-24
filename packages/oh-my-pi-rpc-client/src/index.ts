export { spawnOmpSidecar, type OmpSidecarHandle, type OmpSidecarOptions } from "./sidecar-process.js";
export {
	RpcShimUnsupportedError,
	createRpcSessionDriverShim,
	type RpcSessionDriverShim,
} from "./session-driver-shim.js";
export {
	makeSessionUpdatedEvent,
	mapRpcEventToSessionEvent,
	mapRpcExtensionErrorToSessionEvent,
	mapRpcExtensionUiRequestToHostUiRequest,
	mergeSnapshotUpdate,
	type CachedAvailableCommand,
	type ExtensionUiRequestMapping,
	type RpcEventAdapter,
} from "./event-adapter.js";
export { createRpcConnection, type RpcConnection, type RpcSessionEventListener } from "./rpc-connection.js";
export type {
	FollowUpMode,
	RpcAgentSessionEvent,
	RpcCommand,
	RpcCommandType,
	RpcExtensionErrorEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcImageContent,
	RpcInboundMessage,
	RpcReadyEvent,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	SteeringMode,
	StreamingBehavior,
	ThinkingLevel,
} from "./rpc-types.js";
