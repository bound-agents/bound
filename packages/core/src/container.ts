import "reflect-metadata";
import { container, injectable, singleton } from "tsyringe";
import type { Database } from "bun:sqlite";
import { createDatabase } from "./database";
import { applySchema } from "./schema";
import { loadRequiredConfigs } from "./config-loader";
import { TypedEventEmitter, createLogger } from "@bound/shared";
import { allowlistSchema, modelBackendsSchema } from "@bound/shared";
import type { RequiredConfig } from "./config-loader";

@injectable()
@singleton()
export class DatabaseService {
	private dbInstance!: Database;

	setDatabase(db: Database) {
		this.dbInstance = db;
	}

	getDatabase(): Database {
		return this.dbInstance;
	}
}

@injectable()
@singleton()
export class ConfigService {
	private configInstance!: RequiredConfig;

	setConfig(config: RequiredConfig) {
		this.configInstance = config;
	}

	getConfig(): RequiredConfig {
		return this.configInstance;
	}
}

@injectable()
@singleton()
export class EventBusService {
	private bus = new TypedEventEmitter();

	getEventBus(): TypedEventEmitter {
		return this.bus;
	}
}

@injectable()
@singleton()
export class LoggerService {
	getLogger(pkg: string, component: string) {
		return createLogger(pkg, component);
	}
}

export function bootstrapContainer(configDir: string, dbPath: string) {
	// Load and validate config
	const configResult = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

	if (!configResult.ok) {
		const errors = configResult.error.map((e) => `${e.filename}: ${e.message}`).join("; ");
		throw new Error(`Failed to load configuration: ${errors}`);
	}

	const config = configResult.value;

	// Create and initialize database
	const db = createDatabase(dbPath);
	applySchema(db);

	// Register services
	container.registerSingleton(DatabaseService);
	container.registerSingleton(ConfigService);
	container.registerSingleton(EventBusService);
	container.registerSingleton(LoggerService);

	// Set instances on services
	const dbService = container.resolve(DatabaseService);
	dbService.setDatabase(db);

	const configService = container.resolve(ConfigService);
	configService.setConfig(config);

	return container;
}

export { container };
