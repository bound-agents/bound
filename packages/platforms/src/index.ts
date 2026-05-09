export type { DeliveryVerdict, PlatformConnector } from "./connector.js";
export { PlatformLeaderElection } from "./leader-election.js";
export { PlatformConnectorRegistry } from "./registry.js";
export { DiscordClientManager } from "./connectors/discord-client-manager.js";
export { DiscordConnector } from "./connectors/discord.js";
export { DiscordInteractionConnector } from "./connectors/discord-interaction.js";
export { WebhookStubConnector } from "./connectors/webhook-stub.js";

// New MCP-based platform connector exports
export { PlatformMcpRegistry } from "./mcp-registry.js";
export type { PlatformServerEntry, PlatformMcpRegistryDeps } from "./mcp-registry.js";
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
