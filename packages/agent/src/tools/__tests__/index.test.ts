import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types.js";
import { createAgentTools } from "../index.js";

describe("createAgentTools", () => {
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		siteId = "test-site";
		db = new Database(":memory:");
		applySchema(db);

		// Insert minimal host_meta
		db.exec(`INSERT INTO host_meta (key, value) VALUES ('site_id', '${siteId}')`);
	});

	it("returns all 12 native tools (11 standalone + 1 grouped)", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tools = createAgentTools(toolCtx);

		expect(tools.length).toBe(12);
	});

	it("all tools have kind='builtin'", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tools = createAgentTools(toolCtx);

		for (const tool of tools) {
			expect(tool.kind).toBe("builtin");
		}
	});

	it("all tools have valid toolDefinition with function name and description", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tools = createAgentTools(toolCtx);

		for (const tool of tools) {
			expect(tool.toolDefinition.type).toBe("function");
			expect(typeof tool.toolDefinition.function.name).toBe("string");
			expect(tool.toolDefinition.function.name.length).toBeGreaterThan(0);
			expect(typeof tool.toolDefinition.function.description).toBe("string");
			expect(tool.toolDefinition.function.description.length).toBeGreaterThan(0);
		}
	});

	it("all tools have execute function", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tools = createAgentTools(toolCtx);

		for (const tool of tools) {
			expect(typeof tool.execute).toBe("function");
		}
	});

	it("tools have unique names", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tools = createAgentTools(toolCtx);
		const names = tools.map((t) => t.toolDefinition.function.name);
		const uniqueNames = new Set(names);

		expect(uniqueNames.size).toBe(names.length);
	});

	it("includes all 12 expected tools", () => {
		const toolCtx: ToolContext = {
			db,
			siteId,
			eventBus: { emit: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};

		const tools = createAgentTools(toolCtx);
		const names = new Set(tools.map((t) => t.toolDefinition.function.name));

		const expectedTools = [
			"schedule",
			"query",
			"cancel",
			"emit",
			"await_event",
			"purge",
			"advisory",
			"notify",
			"archive",
			"model_hint",
			"hostinfo",
			"memory",
		];

		for (const expectedName of expectedTools) {
			expect(names.has(expectedName)).toBe(true);
		}
	});
});
