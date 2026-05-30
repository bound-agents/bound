import type { Database } from "bun:sqlite";
import type { StatusForwardPayload, TypedEventEmitter } from "@bound/shared";
import type { MountableFs } from "just-bash";
import { createAdvisoriesRoutes } from "./advisories";
import { createFilesRoutes } from "./files";
import { createMcpRoutes } from "./mcp";
import { createMemoryRoutes } from "./memory";
import { createMessagesRoutes } from "./messages";
import { type BackendPricing, createMetricsRoutes } from "./metrics.js";
import { createSandboxRoutes } from "./sandbox";
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
	/**
	 * The sync server's bind host and port. Forwarded to the webhooks route
	 * so it can enumerate the local webhook delivery URL — webhook
	 * ingestion is on the sync port (3000), distinct from the web port
	 * (3001). See #36.
	 */
	syncBindHost?: string;
	syncPort?: number;
	/**
	 * `sync.hub` from config, if this node is a spoke. Forwarded to the
	 * webhooks route so the hub's public webhook URL appears in the URL
	 * enumeration alongside the local URLs.
	 */
	hubUrl?: string;
	statusForwardCache?: Map<string, StatusForwardPayload>;
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>;
	activeLoops?: Set<string>;
	emitToolCancel?: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void;
	requestConsistency?: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>;
	/**
	 * Live sandbox cluster filesystem reference. When present, exposes
	 * `/api/sandbox/file` for arbitrary path read/write — used by the
	 * `boundless_copy` tool to bridge host and sandbox filesystems
	 * without round-tripping bytes through the LLM context window.
	 */
	clusterFs?: MountableFs | null;
}

export function registerRoutes(db: Database, eventBus: TypedEventEmitter, config: RoutesConfig) {
	const {
		modelsConfig,
		backendPricing,
		hostName = "unknown",
		siteId = "",
		operatorUserId,
		syncBindHost,
		syncPort,
		hubUrl,
		statusForwardCache,
		activeDelegations,
		activeLoops,
		emitToolCancel,
		requestConsistency,
		clusterFs,
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
		webhooks: createWebhooksRoutes(db, {
			syncBindHost,
			syncPort,
			hubUrl,
			hostName,
			siteId,
		}),
		skills: createSkillsRoutes(db),
		metrics: createMetricsRoutes(db, backendPricing),
		sandbox: createSandboxRoutes(clusterFs ?? null),
	};
}
