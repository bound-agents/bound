import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, NON_USER_FACING_INTERFACES, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

export function createMcpRoutes(db: Database): Hono {
	const app = new Hono();

	app.post("/threads", (c) => {
		try {
			const threadId = randomUUID();
			const now = new Date().toISOString();
			const siteId = getSiteId(db);
			const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");

			// Assign next palette color by cycling (0-9) over user-facing threads
			// only — system-driven interfaces (scheduler, webhook, and mcp itself)
			// are excluded so they don't pin the visible cycle to a single color.
			const exclusionPlaceholders = NON_USER_FACING_INTERFACES.map(() => "?").join(", ");
			const lastThread = db
				.query(
					`SELECT color FROM threads WHERE deleted = 0 AND interface NOT IN (${exclusionPlaceholders}) ORDER BY created_at DESC LIMIT 1`,
				)
				.get(...NON_USER_FACING_INTERFACES) as { color: number } | null;
			const nextColor = lastThread !== null ? (lastThread.color + 1) % 10 : 0;

			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: mcpUserId,
					interface: "mcp",
					host_origin: "localhost",
					color: nextColor,
					title: "",
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					model_hint: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			return c.json({ thread_id: threadId }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to create thread", details: message }, 500);
		}
	});

	return app;
}
