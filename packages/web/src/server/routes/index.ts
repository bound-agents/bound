import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { createAdvisoriesRoutes } from "./advisories";
import { createFilesRoutes } from "./files";
import { createMessagesRoutes } from "./messages";
import { type ModelsConfig, createStatusRoutes } from "./status";
import { createTasksRoutes } from "./tasks";
import { createThreadsRoutes } from "./threads";

export type { ModelsConfig };

export interface RoutesConfig {
	modelsConfig?: ModelsConfig;
}

export function registerRoutes(
	db: Database,
	eventBus: TypedEventEmitter,
	config: RoutesConfig = {},
) {
	const { modelsConfig } = config;

	return {
		threads: createThreadsRoutes(db, modelsConfig?.default),
		messages: createMessagesRoutes(db, eventBus),
		files: createFilesRoutes(db),
		status: createStatusRoutes(db, eventBus, modelsConfig),
		tasks: createTasksRoutes(db),
		advisories: createAdvisoriesRoutes(db),
	};
}
