import Database from "bun:sqlite";
import { applyMetricsSchema } from "../metrics-schema";
import { applySchema } from "../schema";

export function createCoreTestDb(options?: { metrics?: boolean }): Database {
	const db = new Database(":memory:");
	applySchema(db);
	if (options?.metrics) applyMetricsSchema(db);
	return db;
}
