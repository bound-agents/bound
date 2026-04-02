import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

export function createMcpRoutes(db: Database): Hono {
	const app = new Hono();

	app.post("/threads", (c) => {
		try {
			const threadId = randomUUID();
			const now = new Date().toISOString();
			const siteId = getSiteId(db);
			const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");

			// Assign next palette color by cycling (0-9)
			const lastThread = db
				.query("SELECT color FROM threads WHERE deleted = 0 ORDER BY created_at DESC LIMIT 1")
				.get() as { color: number } | null;
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
