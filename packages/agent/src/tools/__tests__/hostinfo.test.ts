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
