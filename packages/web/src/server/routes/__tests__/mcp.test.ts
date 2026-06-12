import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { createMcpRoutes } from "../mcp";

interface ServersResponse {
	hosts: Array<{
		site_id: string;
		host_name: string;
		online_at: string | null;
		servers: Array<{
			name: string;
			tools: Array<{ name: string; annotations: Record<string, boolean> }>;
		}>;
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
				commit_hash: null,
			},
			siteId,
		);
	}

	it("returns servers per host with tools derived from captured annotations", async () => {
		seedHost("site-a", "alpha", {
			mcp_servers: JSON.stringify(["github", "pdf"]),
			mcp_tool_annotations: JSON.stringify({
				github: {
					actions_get: { readOnlyHint: true },
					issue_write: { destructiveHint: true, idempotentHint: false },
				},
			}),
			online_at: "2026-06-12T00:00:00.000Z",
		});

		const app = createMcpRoutes(db);
		const res = await app.request("/servers");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServersResponse;

		expect(body.hosts).toHaveLength(1);
		const host = body.hosts[0];
		expect(host.host_name).toBe("alpha");
		expect(host.online_at).toBe("2026-06-12T00:00:00.000Z");
		expect(host.servers.map((s) => s.name)).toEqual(["github", "pdf"]);

		const github = host.servers[0];
		expect(github.tools).toEqual([
			{ name: "actions_get", annotations: { readOnlyHint: true } },
			{ name: "issue_write", annotations: { destructiveHint: true, idempotentHint: false } },
		]);

		// pdf has no captured annotations — empty tool list, not an error.
		expect(host.servers[1].tools).toEqual([]);
	});

	it("returns an empty server list for a host with no MCP servers", async () => {
		seedHost("site-b", "bravo", { mcp_servers: JSON.stringify([]) });

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		expect(body.hosts).toHaveLength(1);
		expect(body.hosts[0].servers).toEqual([]);
	});

	it("tolerates null and malformed JSON columns", async () => {
		seedHost("site-c", "charlie", {
			mcp_servers: "not json",
			mcp_tool_annotations: "{broken",
		});
		seedHost("site-d", "delta", { mcp_servers: null, mcp_tool_annotations: null });

		const app = createMcpRoutes(db);
		const res = await app.request("/servers");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ServersResponse;
		expect(body.hosts).toHaveLength(2);
		for (const host of body.hosts) {
			expect(host.servers).toEqual([]);
		}
	});

	it("excludes deleted hosts and sorts by host name", async () => {
		seedHost("site-z", "zulu", { mcp_servers: JSON.stringify(["metacog"]) });
		seedHost("site-a", "alpha", { mcp_servers: JSON.stringify(["pdf"]) });
		seedHost("site-x", "xray", { mcp_servers: JSON.stringify(["tavily"]), deleted: 1 });

		const app = createMcpRoutes(db);
		const body = (await (await app.request("/servers")).json()) as ServersResponse;
		expect(body.hosts.map((h) => h.host_name)).toEqual(["alpha", "zulu"]);
	});
});
