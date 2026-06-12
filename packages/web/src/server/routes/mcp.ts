import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, NON_USER_FACING_INTERFACES, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

export function createMcpRoutes(db: Database): Hono {
	const app = new Hono();

	/**
	 * Cluster-wide MCP capability inventory, read from the synced `hosts`
	 * table and aggregated BY SERVER rather than by host. Each server entry
	 * lists the hosts it's available on and carries divergence warnings when
	 * hosts disagree about the server's surface (version, tool set, prompt
	 * set, resource set).
	 *
	 * Comparison semantics: only hosts with full capability data
	 * (`mcp_capabilities`) are comparable. Annotation-only hosts (pre-dating
	 * the capabilities column) carry a deliberately partial inventory, so
	 * they're marked `has_capability_data: false` and excluded from
	 * divergence checks instead of manufacturing false warnings. Likewise a
	 * failed listing is recorded as field absence and stays out of that
	 * field's comparison. The displayed inventory comes from the most
	 * recently online capability-bearing host.
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

			interface ServerCapability {
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

			interface HostEntry {
				site_id: string;
				host_name: string;
				online_at: string | null;
				capability: ServerCapability | undefined;
				annotations: Record<string, Record<string, boolean>>;
			}

			const byServer = new Map<string, HostEntry[]>();

			for (const row of rows) {
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

				let capabilities: Record<string, ServerCapability> = {};
				try {
					const parsed: unknown = JSON.parse(row.mcp_capabilities ?? "{}");
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
						capabilities = parsed as Record<string, ServerCapability>;
					}
				} catch {
					// Malformed column — fall back to annotation-derived tools.
				}

				for (const name of serverNames) {
					const capability = capabilities[name];
					const entry: HostEntry = {
						site_id: row.site_id,
						host_name: row.host_name,
						online_at: row.online_at,
						capability:
							capability !== null && typeof capability === "object" ? capability : undefined,
						annotations: annotations[name] ?? {},
					};
					const existing = byServer.get(name);
					if (existing === undefined) {
						byServer.set(name, [entry]);
					} else {
						existing.push(entry);
					}
				}
			}

			/** Newest online_at first; nulls last. */
			function byRecency(a: HostEntry, b: HostEntry): number {
				if (a.online_at === b.online_at) return a.host_name.localeCompare(b.host_name);
				if (a.online_at === null) return 1;
				if (b.online_at === null) return -1;
				return a.online_at < b.online_at ? 1 : -1;
			}

			/**
			 * Compare item sets across hosts; null when fewer than two hosts
			 * report the field or all sets match. The message names exactly
			 * what each lagging host lacks relative to the union.
			 */
			function setDivergence(
				field: string,
				perHost: Array<{ host: string; items: string[] }>,
			): { field: string; message: string } | null {
				if (perHost.length < 2) return null;
				const union = new Set(perHost.flatMap((p) => p.items));
				const lacking = perHost
					.map((p) => {
						const have = new Set(p.items);
						return {
							host: p.host,
							missing: [...union].filter((item) => !have.has(item)).sort(),
						};
					})
					.filter((p) => p.missing.length > 0);
				if (lacking.length === 0) return null;
				const detail = lacking.map((p) => `${p.host} lacks ${p.missing.join(", ")}`).join("; ");
				return { field, message: `${field} differ across hosts: ${detail}` };
			}

			const servers = [...byServer.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, entries]) => {
					const hostsList = entries
						.map((e) => ({
							site_id: e.site_id,
							host_name: e.host_name,
							online_at: e.online_at,
							has_capability_data: e.capability !== undefined,
						}))
						.sort((a, b) => a.host_name.localeCompare(b.host_name));

					const capable = entries.filter((e) => e.capability !== undefined).sort(byRecency);
					const reference = capable[0] ?? [...entries].sort(byRecency)[0];
					const capability = reference?.capability;
					const referenceAnnotations = reference?.annotations ?? {};

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
									annotations: referenceAnnotations[tool.name] ?? {},
								}))
								.sort((a, b) => a.name.localeCompare(b.name))
						: Object.entries(referenceAnnotations)
								.map(([toolName, toolAnnotations]) => ({
									name: toolName,
									annotations: toolAnnotations,
								}))
								.sort((a, b) => a.name.localeCompare(b.name));

					// Divergence is computed only across capability-bearing hosts;
					// each facet additionally requires the field to be present
					// (a failed listing is absence, not emptiness).
					const divergence: Array<{ field: string; message: string }> = [];

					const versions = capable
						.filter((e) => typeof e.capability?.serverInfo?.version === "string")
						.map((e) => ({
							host: e.host_name,
							version: e.capability?.serverInfo?.version as string,
						}));
					if (new Set(versions.map((v) => v.version)).size > 1) {
						const detail = versions
							.sort((a, b) => a.host.localeCompare(b.host))
							.map((v) => `${v.host} reports ${v.version}`)
							.join("; ");
						divergence.push({
							field: "version",
							message: `version differs across hosts: ${detail}`,
						});
					}

					const toolDivergence = setDivergence(
						"tools",
						capable
							.filter((e) => Array.isArray(e.capability?.tools))
							.map((e) => ({
								host: e.host_name,
								items: (e.capability?.tools ?? [])
									.filter((t) => t !== null && typeof t === "object" && typeof t.name === "string")
									.map((t) => t.name),
							})),
					);
					if (toolDivergence !== null) divergence.push(toolDivergence);

					const promptDivergence = setDivergence(
						"prompts",
						capable
							.filter((e) => Array.isArray(e.capability?.prompts))
							.map((e) => ({
								host: e.host_name,
								items: (e.capability?.prompts ?? [])
									.filter((p) => p !== null && typeof p === "object" && typeof p.name === "string")
									.map((p) => p.name),
							})),
					);
					if (promptDivergence !== null) divergence.push(promptDivergence);

					const resourceDivergence = setDivergence(
						"resources",
						capable
							.filter((e) => Array.isArray(e.capability?.resources))
							.map((e) => ({
								host: e.host_name,
								items: (e.capability?.resources ?? [])
									.filter((r) => r !== null && typeof r === "object" && typeof r.uri === "string")
									.map((r) => r.uri),
							})),
					);
					if (resourceDivergence !== null) divergence.push(resourceDivergence);

					return {
						name,
						hosts: hostsList,
						...(capability?.serverInfo && typeof capability.serverInfo === "object"
							? { serverInfo: capability.serverInfo }
							: {}),
						tools,
						...(Array.isArray(capability?.prompts) ? { prompts: capability.prompts } : {}),
						...(Array.isArray(capability?.resources) ? { resources: capability.resources } : {}),
						divergence,
					};
				});

			return c.json({ servers });
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
