import type { Database } from "bun:sqlite";
import type { StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import { createAdvisoriesRoutes } from "./advisories";
import { createFilesRoutes } from "./files";
import { createMcpRoutes } from "./mcp";
import { createMemoryRoutes } from "./memory";
import { createMessagesRoutes } from "./messages";
import { type BackendPricing, createMetricsRoutes } from "./metrics.js";
import { createSkillsRoutes } from "./skills";
import { type ModelsConfig, createStatusRoutes } from "./status";
import { createTasksRoutes } from "./tasks";
import { createThreadsRoutes } from "./threads";
import { createWebhooksRoutes } from "./webhooks";

export type { ModelsConfig };
export type { BackendPricing };

export interface RoutesConfig {
	modelsConfig?: ModelsConfig;
	/**
	 * Per-backend pricing snapshot. Forwarded to the metrics route to
	 * reconstruct per-component cost in the cost-by-model timeline.
	 */
	backendPricing?: BackendPricing[];
	hostName?: string;
	siteId?: string;
	operatorUserId: string;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
	activeLoops?: Set<string>;
	emitToolCancel?: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void;
	requestConsistency?: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>;
}

export function registerRoutes(db: Database, eventBus: TypedEventEmitter, config: RoutesConfig) {
	const {
		modelsConfig,
		backendPricing,
		hostName = "unknown",
		siteId = "",
		operatorUserId,
		statusForwardCache,
		activeDelegations,
		activeLoops,
		emitToolCancel,
		requestConsistency,
	} = config;

	return {
		threads: createThreadsRoutes(
			db,
			operatorUserId,
			modelsConfig?.default,
			statusForwardCache,
			activeLoops,
		),
		messages: createMessagesRoutes(db, eventBus),
		files: createFilesRoutes(db),
		memory: createMemoryRoutes(db),
		status: createStatusRoutes(
			db,
			eventBus,
			hostName,
			siteId,
			modelsConfig,
			activeDelegations,
			undefined,
			emitToolCancel,
			requestConsistency,
		),
		tasks: createTasksRoutes(db),
		advisories: createAdvisoriesRoutes(db),
		mcp: createMcpRoutes(db),
		webhooks: createWebhooksRoutes(db),
		skills: createSkillsRoutes(db),
		metrics: createMetricsRoutes(db, backendPricing),
	};
}
