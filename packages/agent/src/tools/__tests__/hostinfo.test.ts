import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types.js";
import { createHostinfoTool } from "../hostinfo.js";

describe("hostinfo tool", () => {
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		siteId = "test-site";
		db = new Database(":memory:");
		applySchema(db);

		// Insert minimal host_meta
		db.exec(`INSERT INTO host_meta (key, value) VALUES ('site_id', '${siteId}')`);
	});

	it("returns 'No hosts registered' when hosts table is empty", async () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(typeof result).toBe("string");
		expect(result).toContain("No hosts registered");
	});

	it("includes host names in report when hosts are registered", async () => {
		// Insert a host
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, sync_url, modified_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'test-host', '1.0.0', 'ws://localhost:3000', datetime('now'), 0, '[]', '[]', '[]', '{}')`,
		).run(siteId);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(typeof result).toBe("string");
		expect(result).toContain("test-host");
	});

	it("shows cluster size and online status", async () => {
		// Insert two hosts
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'host-1', '1.0.0', ?, 0, '[]', '[]', '[]', '{}')`,
		).run("site-1", now);

		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'host-2', '1.0.0', ?, 0, '[]', '[]', '[]', '{}')`,
		).run("site-2", now);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(typeof result).toBe("string");
		expect(result).toContain("2 nodes");
		expect(result).toContain("online");
	});

	it("renders the commit hash for a node when present (#120)", async () => {
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, commit_hash, modified_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'commit-host', '1.0.0', 'a1b2c3d', datetime('now'), 0, '[]', '[]', '[]', '{}')`,
		).run(siteId);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(result).toContain("commit:");
		expect(result).toContain("a1b2c3d");
	});

	it("omits the commit line when commit_hash is null (#120)", async () => {
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'no-commit-host', '1.0.0', datetime('now'), 0, '[]', '[]', '[]', '{}')`,
		).run(siteId);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(result).not.toContain("commit:");
	});

	it("renders live and stale client sessions (#96)", async () => {
		const now = new Date().toISOString();
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		// Fresh host holding a live session; stale host holding a stale session.
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, online_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'fresh-host', '1.0.0', ?, ?, 0, '[]', '[]', '[]', '{}')`,
		).run("fresh-site", now, now);
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, online_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'stale-host', '1.0.0', ?, ?, 0, '[]', '[]', '[]', '{}')`,
		).run("stale-site", stale, stale);
		db.prepare(
			`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted)
			 VALUES ('bl-live', 'u', 'boundless', 'fresh-site', ?, ?, ?, 0)`,
		).run(now, now, now);
		db.prepare(
			`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted)
			 VALUES ('bl-stale', 'u', 'boundless', 'stale-site', ?, ?, ?, 0)`,
		).run(now, now, now);
		db.prepare(
			`INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted)
			 VALUES ('c1::bl-live', 'c1', 'bl-live', 'fresh-site', ?, ?, 0)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted)
			 VALUES ('c2::bl-stale', 'c2', 'bl-stale', 'stale-site', ?, ?, 0)`,
		).run(now, now);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(result).toContain("Client Sessions:");
		expect(result).toContain("bl-live → boundless @ fresh-host (live)");
		expect(result).toContain("bl-stale → boundless @ stale-host (stale)");
	});

	it("omits the Client Sessions section when there are none", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO hosts (site_id, host_name, version, modified_at, deleted, mcp_servers, mcp_tools, models, platforms)
			 VALUES (?, 'solo-host', '1.0.0', ?, 0, '[]', '[]', '[]', '{}')`,
		).run(siteId, now);

		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);
		const result = await tool.execute({});

		expect(result).not.toContain("Client Sessions:");
	});

	it("tool definition has correct shape", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tool = createHostinfoTool(toolCtx);

		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition.function.name).toBe("hostinfo");
		expect(tool.toolDefinition.function.description).toContain("host");
		expect(typeof tool.execute).toBe("function");
	});
});
