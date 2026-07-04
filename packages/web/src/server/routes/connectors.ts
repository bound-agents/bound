import type { Database } from "bun:sqlite";
import {
	findConnectorHandleById,
	getSiteId,
	listConnectorBindingsWithTask,
	softDelete,
} from "@bound/core";
import { Hono } from "hono";

function parseEventArgs(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

export function createConnectorsRoutes(db: Database): Hono {
	const app = new Hono();

	app.get("/bindings", (c) => {
		try {
			const rows = listConnectorBindingsWithTask(db);
			return c.json({
				bindings: rows.map((row) => ({
					...row,
					event_args_raw: row.event_args,
					event_args: parseEventArgs(row.event_args),
				})),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to list connector bindings", details: message }, 500);
		}
	});

	app.delete("/bindings/:id", (c) => {
		try {
			const { id } = c.req.param();
			const handle = findConnectorHandleById(db, id);
			if (!handle) {
				return c.json({ error: "Connector binding not found" }, 404);
			}

			const siteId = getSiteId(db);
			softDelete(db, "connector_handles", id, siteId);
			if (handle.task_id) {
				softDelete(db, "tasks", handle.task_id, siteId);
			}

			return c.body(null, 204);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to detach connector binding", details: message }, 500);
		}
	});

	return app;
}
