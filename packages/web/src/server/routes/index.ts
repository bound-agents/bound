import type { Database } from "bun:sqlite";
import type { MCPClient } from "@bound/agent";
import type { KeyringConfig, TypedEventEmitter } from "@bound/shared";
import { createFilesRoutes } from "./files";
import { createMCPProxyRoutes } from "./mcp-proxy";
import { createMessagesRoutes } from "./messages";
import { type ModelsConfig, createStatusRoutes } from "./status";
import { createTasksRoutes } from "./tasks";
import { createThreadsRoutes } from "./threads";

export type { ModelsConfig };

export interface RoutesConfig {
	modelsConfig?: ModelsConfig;
	mcpClients?: Map<string, MCPClient>;
	keyring?: KeyringConfig;
}

export function registerRoutes(
	db: Database,
	eventBus: TypedEventEmitter,
	config: RoutesConfig = {},
) {
	const { modelsConfig, mcpClients, keyring } = config;

	return {
		threads: createThreadsRoutes(db, modelsConfig?.default),
		messages: createMessagesRoutes(db, eventBus),
		files: createFilesRoutes(db),
		status: createStatusRoutes(db, eventBus, modelsConfig),
		tasks: createTasksRoutes(db),
		mcpProxy: mcpClients && keyring ? createMCPProxyRoutes(db, mcpClients, keyring) : null,
	};
}
