import { getSiteId } from "@bound/core";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";

export interface ModelInfo {
	id: string;
	provider: string;
}

export interface ModelsConfig {
	models: ModelInfo[];
	default: string;
}

export function createStatusRoutes(
	db: Database,
	eventBus: TypedEventEmitter,
	modelsConfig?: ModelsConfig,
): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const uptime = process.uptime();
			const activeLoops = db
				.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'running'")
				.get() as { count: number };

			const status = {
				host_info: {
					uptime_seconds: Math.floor(uptime),
					active_loops: activeLoops.count,
				},
			};

			return c.json(status);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get status",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/network", (c) => {
		try {
			const hosts = db.query("SELECT * FROM hosts ORDER BY host_name ASC").all() as Array<
				Record<string, unknown>
			>;

			const hubRow = db.query("SELECT value FROM cluster_config WHERE key = 'hub'").get() as {
				value: string;
			} | null;
			const hub = hubRow?.value ?? null;

			const syncState = db.query("SELECT * FROM sync_state").all() as Array<
				Record<string, unknown>
			>;

			return c.json({
				hosts,
				hub,
				syncState,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get network status",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/models", (c) => {
		if (modelsConfig && modelsConfig.models.length > 0) {
			return c.json(modelsConfig);
		}
		return c.json({
			models: [] as ModelInfo[],
			default: "",
		});
	});

	app.post("/cancel/:threadId", (c) => {
		try {
			const { threadId } = c.req.param();

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(threadId);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			// Get siteId and hostName for message persistence
			const siteId = getSiteId(db);

			const hostNameRow = db.query("SELECT value FROM host_meta WHERE key = 'host_name'").get() as
				| { value: string }
				| undefined;
			const hostName = hostNameRow?.value ?? "unknown";

			// Persist cancellation message per spec R-E14
			const cancelMsgId = randomUUID();
			const now = new Date().toISOString();
			insertRow(
				db,
				"messages",
				{
					id: cancelMsgId,
					thread_id: threadId,
					role: "system",
					content: `Agent cancelled by user on host ${hostName}`,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostName,
				},
				siteId,
			);

			// Emit cancel event on eventBus to signal agent loop to stop
			eventBus.emit("agent:cancel", { thread_id: threadId });

			return c.json({
				cancelled: true,
				thread_id: threadId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to cancel agent loop",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
