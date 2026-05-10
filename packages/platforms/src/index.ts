// MCP-based platform connector exports
export { PlatformMcpRegistry } from "./mcp-registry.js";
export type {
	PlatformServerEntry,
	PlatformMcpRegistryDeps,
	PlatformRegisteredTool,
} from "./mcp-registry.js";
export { createDiscordServer } from "./connectors/discord-server.js";
export { connectorHandleId } from "./connector-handle-id.js";
export {
	createConnectorHandle,
	getConnectorHandle,
	getConnectorHandlesByServer,
	getAllActiveConnectorHandles,
	updateConnectorHandleCursor,
	linkConnectorHandleTask,
	deleteConnectorHandle,
} from "./connector-handle.js";
export type { ConnectorHandleCreateParams, ConnectorHandleRecord } from "./connector-handle.js";
export {
	createConnectorListTool,
	createConnectorChannelsTool,
	createConnectorAttachTool,
} from "./dispatcher-tools.js";
export type { DispatcherToolContext } from "./dispatcher-tools.js";
export { seedDispatcher, DISPATCHER_TASK_ID } from "./dispatcher.js";
export { registerConnectorEventListeners } from "./mcp-registry.js";
export { PlatformLeaderElection } from "./leader-election.js";
export { setupDiscordServers } from "./setup-platform-servers.js";
