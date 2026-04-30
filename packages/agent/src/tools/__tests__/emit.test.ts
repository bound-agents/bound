import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import type { ToolContext } from "../../types";
import { createEmitTool } from "../emit";

function getExecute(tool: ReturnType<typeof createEmitTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Emit Tool", () => {
	let db: Database.Database;
	const siteId = "test-site";
	let toolContext: ToolContext;
	let emittedEvents: Record<string, unknown[]>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);

		emittedEvents = {};

		toolContext = {
			db,
			siteId,
			eventBus: {
				on: () => {},
				off: () => {},
				emit: (event: string, payload: unknown) => {
					if (!emittedEvents[event]) {
						emittedEvents[event] = [];
					}
					emittedEvents[event].push(payload);
				},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		};
	});

	afterEach(() => {
		db.close();
	});

	it("should emit event with simple payload", async () => {
		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({
			event: "test:fired",
			payload: '{"key": "value"}',
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/Event emitted: test:fired/);
		expect(emittedEvents["test:fired"]).toBeDefined();
		expect(emittedEvents["test:fired"][0]).toEqual({ key: "value" });
	});

	it("should emit event with default empty payload", async () => {
		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({
			event: "test:empty",
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/Event emitted: test:empty/);
		expect(emittedEvents["test:empty"]).toBeDefined();
		expect(emittedEvents["test:empty"][0]).toEqual({});
	});

	it("should reject invalid JSON payload", async () => {
		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({
			event: "test:invalid",
			payload: "not valid json",
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
		expect(result).toMatch(/JSON/i);
	});

	it("should return error when event is missing", async () => {
		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
		expect(result).toMatch(/event/i);
	});

	it("should handle complex nested payload", async () => {
		const payload = {
			nested: {
				data: [1, 2, 3],
				flag: true,
			},
		};

		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({
			event: "test:complex",
			payload: JSON.stringify(payload),
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);
		expect(emittedEvents["test:complex"][0]).toEqual(payload);
	});

	it("should write relay outbox when hub configured", async () => {
		const now = new Date().toISOString();

		// Configure cluster hub
		insertRow(
			db,
			"cluster_config",
			{
				key: "cluster_hub",
				value: "https://hub.example.com",
				modified_at: now,
			},
			siteId,
		);

		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({
			event: "test:relay",
			payload: '{"data": "test"}',
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		// Check relay_outbox was written
		const outboxEntries = db
			.prepare("SELECT COUNT(*) as count FROM relay_outbox WHERE kind = 'event_broadcast'")
			.get() as { count: number };

		expect(outboxEntries.count).toBe(1);
	});

	it("should not write relay outbox when hub not configured", async () => {
		// No cluster_hub configured
		const tool = createEmitTool(toolContext);
		const result = await getExecute(tool)({
			event: "test:no-relay",
			payload: '{"data": "test"}',
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		// Check relay_outbox was NOT written
		const outboxEntries = db
			.prepare("SELECT COUNT(*) as count FROM relay_outbox WHERE kind = 'event_broadcast'")
			.get() as { count: number };

		expect(outboxEntries.count).toBe(0);
	});

	it("tool should have valid RegisteredTool shape", () => {
		const tool = createEmitTool(toolContext);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition).toBeDefined();
		expect(tool.toolDefinition.function.name).toBe("emit");
		expect(tool.toolDefinition.function.description).toBeDefined();
		expect(tool.toolDefinition.function.parameters).toBeDefined();
		expect(tool.execute).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("tool definition should require event parameter", () => {
		const tool = createEmitTool(toolContext);
		const params = tool.toolDefinition.function.parameters as any;
		expect(params.properties.event).toBeDefined();
		expect(params.properties.payload).toBeDefined();
		expect(params.required).toContain("event");
	});
});
