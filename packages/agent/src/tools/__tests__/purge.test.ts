import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { randomUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createPurgeTool } from "../purge";

function getExecute(tool: ReturnType<typeof createPurgeTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Purge Tool", () => {
	let db: Database.Database;
	const siteId = "test-site";
	let toolContext: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);

		toolContext = {
			db,
			siteId,
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
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

	it("should purge by message_ids", async () => {
		const threadId = randomUUID();
		const msgId1 = randomUUID();
		const msgId2 = randomUUID();
		const now = new Date().toISOString();

		// Create messages
		insertRow(
			db,
			"messages",
			{
				id: msgId1,
				thread_id: threadId,
				role: "user",
				content: "hello",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: siteId,
			},
			siteId,
		);

		insertRow(
			db,
			"messages",
			{
				id: msgId2,
				thread_id: threadId,
				role: "assistant",
				content: "hi",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: siteId,
			},
			siteId,
		);

		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({
			message_ids: `${msgId1}, ${msgId2}`,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);
		expect(result).toMatch(/purge message created/i);
		expect(result).toMatch(/2/); // Should say 2 messages targeted

		// Verify purge message was created
		const purgeMessages = db
			.prepare("SELECT COUNT(*) as count FROM messages WHERE role = 'purge'")
			.get() as { count: number };
		expect(purgeMessages.count).toBe(1);

		// Verify purge message contains target IDs
		const purgeMsg = db.prepare("SELECT content FROM messages WHERE role = 'purge'").get() as {
			content: string;
		};
		const purgeContent = JSON.parse(purgeMsg.content);
		expect(purgeContent.target_ids).toContain(msgId1);
		expect(purgeContent.target_ids).toContain(msgId2);
	});

	it("should purge by last_n messages", async () => {
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create 5 messages
		const msgIds = [];
		for (let i = 0; i < 5; i++) {
			const msgId = randomUUID();
			msgIds.push(msgId);

			insertRow(
				db,
				"messages",
				{
					id: msgId,
					thread_id: threadId,
					role: i % 2 === 0 ? "user" : "assistant",
					content: `message ${i}`,
					model_id: null,
					tool_name: null,
					created_at: new Date(Date.now() + i * 1000).toISOString(),
					modified_at: now,
					host_origin: siteId,
				},
				siteId,
			);
		}

		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({
			last_n: 2,
			thread_id: threadId,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);
		expect(result).toMatch(/2/); // Should target last 2 messages

		const purgeMsg = db.prepare("SELECT content FROM messages WHERE role = 'purge'").get() as {
			content: string;
		};
		const purgeContent = JSON.parse(purgeMsg.content);
		// The last 2 messages should be targeted (reverse order, DESC LIMIT 2)
		expect(purgeContent.target_ids.length).toBe(2);
	});

	it("should preserve tool-pair integrity", async () => {
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create tool_call and tool_result pair
		const toolCallId = randomUUID();
		const toolResultId = randomUUID();

		insertRow(
			db,
			"messages",
			{
				id: toolCallId,
				thread_id: threadId,
				role: "tool_call",
				content: '{"tool":"test","input":{}}',
				model_id: null,
				tool_name: "test",
				created_at: now,
				modified_at: now,
				host_origin: siteId,
			},
			siteId,
		);

		insertRow(
			db,
			"messages",
			{
				id: toolResultId,
				thread_id: threadId,
				role: "tool_result",
				content: "result data",
				model_id: null,
				tool_name: "test",
				created_at: new Date(Date.now() + 1000).toISOString(),
				modified_at: now,
				host_origin: siteId,
			},
			siteId,
		);

		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({
			message_ids: toolCallId,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		// Should have targeted 2 messages (tool_call + tool_result)
		expect(result).toMatch(/2/);

		const purgeMsg = db.prepare("SELECT content FROM messages WHERE role = 'purge'").get() as {
			content: string;
		};
		const purgeContent = JSON.parse(purgeMsg.content);

		expect(purgeContent.target_ids).toContain(toolCallId);
		expect(purgeContent.target_ids).toContain(toolResultId);
	});

	it("should include custom summary", async () => {
		const threadId = randomUUID();
		const msgId = randomUUID();
		const now = new Date().toISOString();

		insertRow(
			db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "user",
				content: "hello",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: siteId,
			},
			siteId,
		);

		const customSummary = "Removing sensitive data";

		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({
			message_ids: msgId,
			summary: customSummary,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);

		const purgeMsg = db.prepare("SELECT content FROM messages WHERE role = 'purge'").get() as {
			content: string;
		};
		const purgeContent = JSON.parse(purgeMsg.content);

		expect(purgeContent.summary).toBe(customSummary);
	});

	it("should return error when neither message_ids nor last_n provided", async () => {
		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
		expect(result).toMatch(/must specify/i);
	});

	it("should return error when last_n without thread_id", async () => {
		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({
			last_n: 5,
		});

		expect(typeof result).toBe("string");
		expect(result).toMatch(/^Error/);
		expect(result).toMatch(/thread_id|required/i);
	});

	it("should fall back to ctx.threadId when last_n used without thread_id param", async () => {
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create messages
		const msgId1 = randomUUID();
		const msgId2 = randomUUID();

		for (const msgId of [msgId1, msgId2]) {
			insertRow(
				db,
				"messages",
				{
					id: msgId,
					thread_id: threadId,
					role: "user",
					content: "test",
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: siteId,
				},
				siteId,
			);
		}

		// Set threadId in context
		toolContext.threadId = threadId;

		const tool = createPurgeTool(toolContext);
		const result = await getExecute(tool)({
			last_n: 1,
		});

		expect(typeof result).toBe("string");
		expect(result).not.toMatch(/^Error/);
	});

	it("tool should have valid RegisteredTool shape", () => {
		const tool = createPurgeTool(toolContext);
		expect(tool.kind).toBe("builtin");
		expect(tool.toolDefinition).toBeDefined();
		expect(tool.toolDefinition.function.name).toBe("purge");
		expect(tool.toolDefinition.function.description).toBeDefined();
		expect(tool.toolDefinition.function.parameters).toBeDefined();
		expect(tool.execute).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("tool definition should have message_ids, last_n, thread_id, summary properties", () => {
		const tool = createPurgeTool(toolContext);
		const params = tool.toolDefinition.function.parameters as any;
		expect(params.properties.message_ids).toBeDefined();
		expect(params.properties.last_n).toBeDefined();
		expect(params.properties.thread_id).toBeDefined();
		expect(params.properties.summary).toBeDefined();
	});
});
