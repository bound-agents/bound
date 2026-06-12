import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, NON_USER_FACING_INTERFACES, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

export function createMcpRoutes(db: Database): Hono {
	const app = new Hono();

	/**
	 * Cluster-wide MCP capability inventory, read from the synced `hosts`
	 * table. `mcp_servers` holds connected server names; tool names and
	 * their MCP-spec annotations come from `mcp_tool_annotations`
	 * ({serverName: {toolName: annotations}}), which only records tools
	 * that reported at least one annotation hint — a server with an empty
	 * tool list here may still expose (unannotated) tools.
	 */
	app.get("/servers", (c) => {
		try {
			const rows = db
				.query(
					"SELECT site_id, host_name, online_at, mcp_servers, mcp_tool_annotations FROM hosts WHERE deleted = 0 ORDER BY host_name",
				)
				.all() as Array<{
				site_id: string;
				host_name: string;
				online_at: string | null;
				mcp_servers: string | null;
				mcp_tool_annotations: string | null;
			}>;

			const hosts = rows.map((row) => {
				let serverNames: string[] = [];
				try {
					const parsed: unknown = JSON.parse(row.mcp_servers ?? "[]");
					if (Array.isArray(parsed)) {
						serverNames = parsed.filter((s): s is string => typeof s === "string");
					}
				} catch {
					// Malformed column — treat as no servers rather than failing the route.
				}

				let annotations: Record<string, Record<string, Record<string, boolean>>> = {};
				try {
					const parsed: unknown = JSON.parse(row.mcp_tool_annotations ?? "{}");
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
						annotations = parsed as Record<string, Record<string, Record<string, boolean>>>;
					}
				} catch {
					// Malformed column — render servers without tool detail.
				}

				const servers = serverNames.map((name) => ({
					name,
					tools: Object.entries(annotations[name] ?? {})
						.map(([toolName, toolAnnotations]) => ({
							name: toolName,
							annotations: toolAnnotations,
						}))
						.sort((a, b) => a.name.localeCompare(b.name)),
				}));

				return {
					site_id: row.site_id,
					host_name: row.host_name,
					online_at: row.online_at,
					servers,
				};
			});

			return c.json({ hosts });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to list MCP servers", details: message }, 500);
		}
	});

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
