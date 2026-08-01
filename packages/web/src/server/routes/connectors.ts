import type { Database } from "bun:sqlite";
import {
	findConnectorHandleById,
	findTaskById,
	getSiteId,
	listConnectorBindingsWithTask,
	softDelete,
	updateRow,
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

	// PATCH /bindings/:id — update the binding's model.
	//
	// `connector_handles` has no model column: the model that runs a delivery
	// lives on the backing event task (and is mirrored onto its delivery thread,
	// matching webhook and RSS PATCH semantics). So this route resolves the
	// handle → task → thread chain and writes there.
	//
	// model_hint is three-state: absent → leave alone; null/"" → clear back to the
	// cluster default; non-empty string → set.
	app.patch("/bindings/:id", async (c) => {
		try {
			const { id } = c.req.param();
			const body = (await c.req.json()) as Record<string, unknown>;

			const handle = findConnectorHandleById(db, id);
			if (!handle) {
				return c.json({ error: "Connector binding not found" }, 404);
			}

			if (!("model_hint" in body)) {
				return c.json({ error: "Provide at least one of: model_hint" }, 400);
			}

			const rawModelHint = body.model_hint;
			if (rawModelHint !== null && rawModelHint !== undefined && typeof rawModelHint !== "string") {
				return c.json({ error: "model_hint must be a string or null" }, 400);
			}
			const modelHintValue =
				typeof rawModelHint === "string" && rawModelHint.length > 0 ? rawModelHint : null;

			// A handle whose task row is missing (detached task, replay gap) has
			// nowhere to record a model. Say so rather than silently no-op'ing.
			if (!handle.task_id) {
				return c.json(
					{ error: "Connector binding has no backing event task; cannot set a model" },
					409,
				);
			}
			const task = findTaskById(db, handle.task_id);
			if (!task) {
				return c.json(
					{ error: "Connector binding has no backing event task; cannot set a model" },
					409,
				);
			}

			const siteId = getSiteId(db);
			updateRow(db, "tasks", task.id, { model_hint: modelHintValue }, siteId);
			if (task.thread_id) {
				updateRow(db, "threads", task.thread_id, { model_hint: modelHintValue }, siteId);
			}

			const updated = listConnectorBindingsWithTask(db).find((row) => row.id === id);
			if (!updated) {
				return c.json({ error: "Connector binding not found" }, 404);
			}
			return c.json({
				...updated,
				event_args_raw: updated.event_args,
				event_args: parseEventArgs(updated.event_args),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to update connector binding", details: message }, 500);
		}
	});

	return app;
}
