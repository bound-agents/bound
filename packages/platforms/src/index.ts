// MCP-based platform connector exports
export { PlatformMcpRegistry } from "./mcp-registry.js";
export type {
	PlatformServerEntry,
	PlatformMcpRegistryDeps,
	PlatformRegisteredTool,
	RemotePlatformRequest,
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
export { createConnectorTool } from "./connector-tool.js";
export type { ConnectorToolContext, ConnectorToolDef } from "./connector-tool.js";
export { registerConnectorEventDelivery } from "./mcp-registry.js";
export { PlatformLeaderElection } from "./leader-election.js";
export { setupDiscordServers } from "./setup-platform-servers.js";
