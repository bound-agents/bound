import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export function openBoundDB(configDir?: string): Database {
	const dir = configDir || "data";
	return new Database(resolve(dir, "bound.db"));
}
