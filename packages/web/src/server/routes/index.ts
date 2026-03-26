import type { Database } from "bun:sqlite";
import type { StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import { createAdvisoriesRoutes } from "./advisories";
import { createFilesRoutes } from "./files";
import { createMessagesRoutes } from "./messages";
import { type ModelsConfig, createStatusRoutes } from "./status";
import { createTasksRoutes } from "./tasks";
import { createThreadsRoutes } from "./threads";

export type { ModelsConfig };

export interface RoutesConfig {
	modelsConfig?: ModelsConfig;
	hostName?: string;
	siteId?: string;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
}

export function registerRoutes(
	db: Database,
	eventBus: TypedEventEmitter,
	config: RoutesConfig = {},
) {
	const { modelsConfig, hostName = "unknown", siteId = "", statusForwardCache, activeDelegations } =
		config;

	return {
		threads: createThreadsRoutes(db, modelsConfig?.default, statusForwardCache),
		messages: createMessagesRoutes(db, eventBus),
		files: createFilesRoutes(db),
		status: createStatusRoutes(db, eventBus, hostName, siteId, modelsConfig, activeDelegations),
		tasks: createTasksRoutes(db),
		advisories: createAdvisoriesRoutes(db),
	};
}
