import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import type { OptionalConfigs, RequiredConfig } from "./config-loader";
import { loadOptionalConfigs } from "./config-loader";
import { bootstrapContainer } from "./container";
import { ConfigService, DatabaseService, EventBusService, LoggerService } from "./container";
import { InMemoryTurnStateStore, type TurnStateStore } from "./turn-state-store";

export interface AppContext {
	db: Database;
	config: RequiredConfig;
	optionalConfig: OptionalConfigs;
	eventBus: TypedEventEmitter;
	logger: Logger;
	siteId: string;
	hostName: string;
	/**
	 * Per-thread agent turn-state cache. Keyed by threadId. Survives
	 * AgentLoop instance teardown so warm-path cache reuse works across
	 * client-tool defer/wakeup cycles. Lifetime is process-scoped with
	 * internal TTL shorter than upstream prompt-cache TTL.
	 */
	turnStateStore: TurnStateStore;
}

export function createAppContext(configDir: string, dbPath: string): AppContext {
	const container = bootstrapContainer(configDir, dbPath);

	const dbService = container.resolve(DatabaseService);
	const configService = container.resolve(ConfigService);
	const eventBusService = container.resolve(EventBusService);
	const loggerService = container.resolve(LoggerService);

	const db = dbService.getDatabase();
	const config = configService.getConfig();
	const eventBus = eventBusService.getEventBus();
	const logger = loggerService.getLogger("@bound/core", "app-context");

	// Initialize host_meta table with site_id if not present
	const hostMeta = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as
		| {
				value: string;
		  }
		| undefined;

	let siteId: string;
	if (hostMeta) {
		siteId = hostMeta.value;
	} else {
		// Generate a new site_id for this host
		siteId = randomUUID();
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", siteId]);
		logger.info("Generated new site_id", { siteId });
	}

	// Get host name from OS
	const hostName = hostname() || "localhost";

	// Load optional configs
	const optionalConfigs = loadOptionalConfigs(configDir);

	return {
		db,
		config,
		optionalConfig: optionalConfigs,
		eventBus,
		logger,
		siteId,
		hostName,
		turnStateStore: new InMemoryTurnStateStore(),
	};
}
