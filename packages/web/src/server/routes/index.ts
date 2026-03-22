import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import { createFilesRoutes } from "./files";
import { createMessagesRoutes } from "./messages";
import { createStatusRoutes } from "./status";
import { createTasksRoutes } from "./tasks";
import { createThreadsRoutes } from "./threads";

export function registerRoutes(db: Database, eventBus: TypedEventEmitter) {
	return {
		threads: createThreadsRoutes(db),
		messages: createMessagesRoutes(db, eventBus),
		files: createFilesRoutes(db),
		status: createStatusRoutes(db, eventBus),
		tasks: createTasksRoutes(db),
	};
}
