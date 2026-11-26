import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
	type CommandRegistryEntry,
	type Logger,
	type ModelBackendsConfig,
	TypedEventEmitter,
	allowlistSchema,
	createLogger,
	modelBackendsSchema,
} from "@bound/shared";
import type { OptionalConfigs, RequiredConfig } from "./config-loader";
import { loadOptionalConfigs, loadRequiredConfigs } from "./config-loader";
import { createDatabase } from "./database";
import { applyMetricsSchema } from "./metrics-schema";
import { ensureHostMetaSiteId } from "./repositories/host-meta";
import { applySchema } from "./schema";
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
	 * Keyed by threadId. Outlives MainAgentLoop instances so warm-path cache
	 * reuse survives client-tool defer/wakeup cycles; its TTL stays shorter
	 * than the upstream prompt-cache TTL.
	 */
	turnStateStore: TurnStateStore;
	/** MCP commands registered at startup and replaced on hot-reload. */
	commandRegistry: CommandRegistryEntry[];
}

export async function createAppContext(
	configDir: string,
	dbPath: string,
	modelBackends?: ModelBackendsConfig,
): Promise<AppContext> {
	const configResult = await loadRequiredConfigs(
		configDir,
		allowlistSchema,
		modelBackendsSchema,
		modelBackends,
	);
	if (!configResult.ok) {
		const errors = configResult.error.map((e) => `${e.filename}: ${e.message}`).join("; ");
		throw new Error(`Failed to load configuration: ${errors}`);
	}

	const db = createDatabase(dbPath);
	applySchema(db);
	applyMetricsSchema(db);

	const logger = createLogger("@bound/core", "app-context");
	const { siteId, created } = ensureHostMetaSiteId(db, randomUUID);
	if (created) logger.info("Generated new site_id", { siteId });

	return {
		db,
		config: configResult.value,
		optionalConfig: await loadOptionalConfigs(configDir),
		eventBus: new TypedEventEmitter(),
		logger,
		siteId,
		hostName: hostname() || "localhost",
		turnStateStore: new InMemoryTurnStateStore(55 * 60 * 1000),
		commandRegistry: [],
	};
}
