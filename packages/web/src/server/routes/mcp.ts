import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, NON_USER_FACING_INTERFACES, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

export function createMcpRoutes(db: Database): Hono {
	const app = new Hono();

	/**
	 * Cluster-wide MCP capability inventory, read from the synced `hosts`
	 * table. `mcp_servers` holds connected server names. `mcp_capabilities`
	 * ({serverName: {serverInfo?, tools?, prompts?, resources?}}) carries the
	 * full surface each server exposes to agents; when present, tools come
	 * from it (full inventory) with per-tool annotations merged in from
	 * `mcp_tool_annotations`. Hosts that pre-date the capabilities column
	 * fall back to annotation-derived tools, which only include tools that
	 * reported at least one annotation hint.
	 */
	app.get("/servers", (c) => {
		try {
			const rows = db
				.query(
					"SELECT site_id, host_name, online_at, mcp_servers, mcp_tool_annotations, mcp_capabilities FROM hosts WHERE deleted = 0 ORDER BY host_name",
				)
				.all() as Array<{
				site_id: string;
				host_name: string;
				online_at: string | null;
				mcp_servers: string | null;
				mcp_tool_annotations: string | null;
				mcp_capabilities: string | null;
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

				let capabilities: Record<
					string,
					{
						serverInfo?: Record<string, string>;
						tools?: Array<{ name: string; description?: string }>;
						prompts?: Array<{ name: string; description?: string }>;
						resources?: Array<{
							uri: string;
							name?: string;
							description?: string;
							mimeType?: string;
						}>;
					}
				> = {};
				try {
					const parsed: unknown = JSON.parse(row.mcp_capabilities ?? "{}");
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
						capabilities = parsed as typeof capabilities;
					}
				} catch {
					// Malformed column — fall back to annotation-derived tools.
				}

				const servers = serverNames.map((name) => {
					const serverAnnotations = annotations[name] ?? {};
					const capability = capabilities[name];

					const tools = Array.isArray(capability?.tools)
						? capability.tools
								.filter((t): t is { name: string; description?: string } => {
									return t !== null && typeof t === "object" && typeof t.name === "string";
								})
								.map((tool) => ({
									name: tool.name,
									...(typeof tool.description === "string"
										? { description: tool.description }
										: {}),
									annotations: serverAnnotations[tool.name] ?? {},
								}))
								.sort((a, b) => a.name.localeCompare(b.name))
						: Object.entries(serverAnnotations)
								.map(([toolName, toolAnnotations]) => ({
									name: toolName,
									annotations: toolAnnotations,
								}))
								.sort((a, b) => a.name.localeCompare(b.name));

					return {
						name,
						...(capability?.serverInfo && typeof capability.serverInfo === "object"
							? { serverInfo: capability.serverInfo }
							: {}),
						tools,
						...(Array.isArray(capability?.prompts) ? { prompts: capability.prompts } : {}),
						...(Array.isArray(capability?.resources) ? { resources: capability.resources } : {}),
					};
				});

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
