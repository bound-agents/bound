import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { createMcpRoutes } from "../mcp";

interface ServersResponse {
	servers: Array<{
		name: string;
		hosts: Array<{
			site_id: string;
			host_name: string;
			online_at: string | null;
			has_capability_data: boolean;
		}>;
		serverInfo?: {
			name?: string;
			title?: string;
			version?: string;
			description?: string;
			instructions?: string;
		};
		tools: Array<{ name: string; description?: string; annotations: Record<string, boolean> }>;
		prompts?: Array<{ name: string; description?: string }>;
		resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
		divergence: Array<{ field: string; message: string }>;
	}>;
}

describe("createMcpRoutes GET /servers", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	function seedHost(
		siteId: string,
		hostName: string,
		fields: Partial<{
			mcp_servers: string | null;
			mcp_tools: string | null;
			mcp_tool_annotations: string | null;
			mcp_capabilities: string | null;
			online_at: string | null;
			deleted: number;
		}> = {},
	): void {
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: hostName,
				version: null,
				sync_url: null,
				mcp_servers: fields.mcp_servers ?? null,
				mcp_tools: fields.mcp_tools ?? null,
				models: null,
				overlay_root: null,
				online_at: fields.online_at ?? null,
				modified_at: new Date().toISOString(),
				deleted: fields.deleted ?? 0,
				platforms: null,
				mcp_tool_annotations: fields.mcp_tool_annotations ?? null,
				mcp_capabilities: fields.mcp_capabilities ?? null,
				commit_hash: null,
			},
			siteId,
		);
	}

	function capability(
		overrides: Partial<{
			serverInfo: Record<string, string>;
			tools: Array<{ name: string; description?: string }>;
			prompts: Array<{ name: string; description?: string }>;
			resources: Array<{ uri: string; name?: string; mimeType?: string }>;
		}> = {},
	): Record<string, unknown> {
		return {
			serverInfo: overrides.serverInfo ?? { name: "github-mcp", version: "2.1.0" },
			tools: overrides.tools ?? [{ name: "actions_get" }, { name: "issue_write" }],
			prompts: overrides.prompts ?? [{ name: "review_pr" }],
			resources: overrides.resources ?? [{ uri: "repo://readme" }],
		};
	}

	it("groups a server available on multiple hosts into one entry with no divergence when identical", async () => {
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({ github: capability() }),
			online_at: "2026-06-12T00:00:00.000Z",
		});
		seedHost("site-b", "bravo", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({ github: capability() }),
			online_at: "2026-06-11T00:00:00.000Z",
		});

		const app = createMcpRoutes(db);
		const res = await app.request("/servers");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServersResponse;

		expect(body.servers).toHaveLength(1);
		const github = body.servers[0];
		expect(github.name).toBe("github");
		expect(github.hosts.map((h) => h.host_name)).toEqual(["alpha", "bravo"]);
		expect(github.hosts.every((h) => h.has_capability_data)).toBe(true);
		expect(github.divergence).toEqual([]);
		expect(github.serverInfo?.version).toBe("2.1.0");
	});

	it("warns when serverInfo versions differ across hosts", async () => {
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({ serverInfo: { name: "github-mcp", version: "2.1.0" } }),
			}),
		});
		seedHost("site-b", "bravo", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({ serverInfo: { name: "github-mcp", version: "2.0.0" } }),
			}),
		});

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		const divergence = body.servers[0].divergence;
		expect(divergence).toHaveLength(1);
		expect(divergence[0].field).toBe("version");
		expect(divergence[0].message).toContain("alpha");
		expect(divergence[0].message).toContain("2.1.0");
		expect(divergence[0].message).toContain("bravo");
		expect(divergence[0].message).toContain("2.0.0");
	});

	it("warns when tool inventories differ across hosts, naming what each host lacks", async () => {
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({ tools: [{ name: "actions_get" }, { name: "issue_write" }] }),
			}),
		});
		seedHost("site-b", "bravo", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({ tools: [{ name: "actions_get" }] }),
			}),
		});

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		const divergence = body.servers[0].divergence;
		expect(divergence).toHaveLength(1);
		expect(divergence[0].field).toBe("tools");
		expect(divergence[0].message).toContain("bravo");
		expect(divergence[0].message).toContain("issue_write");
	});

	it("warns on prompt and resource set divergence independently", async () => {
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({
					prompts: [{ name: "review_pr" }, { name: "summarize" }],
					resources: [{ uri: "repo://readme" }, { uri: "repo://changelog" }],
				}),
			}),
		});
		seedHost("site-b", "bravo", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({
					prompts: [{ name: "review_pr" }],
					resources: [{ uri: "repo://readme" }],
				}),
			}),
		});

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		const fields = body.servers[0].divergence.map((d) => d.field).sort();
		expect(fields).toEqual(["prompts", "resources"]);
	});

	it("excludes annotation-only hosts from divergence comparison and marks them partial", async () => {
		// alpha has full capability data; charlie pre-dates the capabilities
		// column and only has annotation-derived tools (a partial inventory).
		// charlie's smaller tool set must NOT manufacture a divergence warning.
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({ github: capability() }),
			online_at: "2026-06-12T00:00:00.000Z",
		});
		seedHost("site-c", "charlie", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_tool_annotations: JSON.stringify({
				github: { actions_get: { readOnlyHint: true } },
			}),
			online_at: "2026-06-12T01:00:00.000Z",
		});

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		const github = body.servers[0];

		expect(github.divergence).toEqual([]);
		const alpha = github.hosts.find((h) => h.host_name === "alpha");
		const charlie = github.hosts.find((h) => h.host_name === "charlie");
		expect(alpha?.has_capability_data).toBe(true);
		expect(charlie?.has_capability_data).toBe(false);
		// Display inventory comes from the capability-bearing host even though
		// charlie was online more recently.
		expect(github.tools.map((t) => t.name)).toEqual(["actions_get", "issue_write"]);
	});

	it("prefers the most recently online capability-bearing host as the display source", async () => {
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_capabilities: JSON.stringify({
				github: capability({ serverInfo: { name: "github-mcp", version: "2.0.0" } }),
			}),
			online_at: "2026-06-10T00:00:00.000Z",
		});
		seedHost("site-b", "bravo", {
			mcp_servers: JSON.stringify(["github"]),
			mcp_tool_annotations: JSON.stringify({
				github: { actions_get: { readOnlyHint: true } },
			}),
			mcp_capabilities: JSON.stringify({
				github: capability({ serverInfo: { name: "github-mcp", version: "2.1.0" } }),
			}),
			online_at: "2026-06-12T00:00:00.000Z",
		});

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		const github = body.servers[0];

		expect(github.serverInfo?.version).toBe("2.1.0");
		// Annotations merge from the same host the inventory came from.
		const actionsGet = github.tools.find((t) => t.name === "actions_get");
		expect(actionsGet?.annotations).toEqual({ readOnlyHint: true });
		// The version difference itself still warns.
		expect(github.divergence.map((d) => d.field)).toEqual(["version"]);
	});

	it("falls back to annotation-derived tools when no host has capability data", async () => {
		seedHost("site-c", "charlie", {
			mcp_servers: JSON.stringify(["pdf"]),
			mcp_tool_annotations: JSON.stringify({
				pdf: { extract: { readOnlyHint: true } },
			}),
		});

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		const pdf = body.servers[0];
		expect(pdf.serverInfo).toBeUndefined();
		expect(pdf.prompts).toBeUndefined();
		expect(pdf.resources).toBeUndefined();
		expect(pdf.tools).toEqual([{ name: "extract", annotations: { readOnlyHint: true } }]);
		expect(pdf.divergence).toEqual([]);
	});

	it("tolerates null and malformed JSON columns", async () => {
		seedHost("site-c", "charlie", {
			mcp_servers: "not json",
			mcp_tool_annotations: "{broken",
			mcp_capabilities: "{broken",
		});
		seedHost("site-d", "delta", { mcp_servers: null });

		const app = createMcpRoutes(db);
		const res = await app.request("/servers");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServersResponse;
		expect(body.servers).toEqual([]);
	});

	it("excludes deleted hosts and sorts servers by name", async () => {
		seedHost("site-z", "zulu", { mcp_servers: JSON.stringify(["metacog", "atproto"]) });
		seedHost("site-x", "xray", { mcp_servers: JSON.stringify(["tavily"]), deleted: 1 });

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		expect(body.servers.map((s) => s.name)).toEqual(["atproto", "metacog"]);
		// xray is deleted — tavily must not appear.
	});
});
