import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow, softDelete } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createNotifyTool } from "../notify";

describe("notify tool", () => {
	let db: Database.Database;
	let ctx: ToolContext;
	let emittedEvents: Array<{ event: string; payload: unknown }>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		emittedEvents = [];

		ctx = {
			db,
			siteId: "test-site",
			eventBus: {
				on: () => {},
				off: () => {},
				emit: (event: string, payload: unknown) => {
					emittedEvents.push({ event, payload });
				},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: "current-thread",
		};
	});

	afterEach(() => {
		db.close();
	});

	it("enqueues notification for valid thread_id", async () => {
		const tool = createNotifyTool(ctx);
		const now = new Date().toISOString();

		insertRow(
			db,
			"threads",
			{
				id: "target-thread",
				user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
				interface: "web",
				host_origin: "test-host",
				title: "Test Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			thread_id: "target-thread",
			message: "Hello",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("enqueued");

		expect(emittedEvents.length).toBe(1);
		expect(emittedEvents[0].event).toBe("notify:enqueued");
		expect(emittedEvents[0].payload).toEqual({ thread_id: "target-thread" });

		const queueEntry = db
			.prepare("SELECT message_id FROM dispatch_queue WHERE thread_id = ? LIMIT 1")
			.get("target-thread") as { message_id: string } | null;
		expect(queueEntry).not.toBeNull();
	});

	it("returns error when thread_id is missing", async () => {
		const tool = createNotifyTool(ctx);

		const result = await tool.execute({
			message: "Hello",
		} as any);

		expect(result).toContain("Error");
		expect(emittedEvents.length).toBe(0);
	});

	it("returns error for non-existent thread", async () => {
		const tool = createNotifyTool(ctx);

		const result = await tool.execute({
			thread_id: "nonexistent",
			message: "Hello",
		});

		expect(result).toContain("Error");
		expect(emittedEvents.length).toBe(0);
	});

	it("returns error for soft-deleted thread", async () => {
		const tool = createNotifyTool(ctx);
		const now = new Date().toISOString();

		insertRow(
			db,
			"threads",
			{
				id: "deleted-thread",
				user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
				interface: "web",
				host_origin: "test-host",
				title: "Deleted Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		softDelete(db, "threads", "deleted-thread", ctx.siteId);

		const result = await tool.execute({
			thread_id: "deleted-thread",
			message: "Hello",
		});

		expect(result).toContain("Error");
		expect(emittedEvents.length).toBe(0);
	});

	it("returns error for self-notify (thread_id matches current thread)", async () => {
		const tool = createNotifyTool(ctx);
		const now = new Date().toISOString();

		insertRow(
			db,
			"threads",
			{
				id: "current-thread",
				user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
				interface: "web",
				host_origin: "test-host",
				title: "Current Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			thread_id: "current-thread",
			message: "Hello",
		});

		expect(result).toContain("Error");
		expect(result.toLowerCase()).toContain("current thread");
		expect(emittedEvents.length).toBe(0);
	});

	it("returns error for empty or whitespace-only message", async () => {
		const tool = createNotifyTool(ctx);
		const now = new Date().toISOString();

		insertRow(
			db,
			"threads",
			{
				id: "target-thread",
				user_id: deterministicUUID(BOUND_NAMESPACE, "test-user"),
				interface: "web",
				host_origin: "test-host",
				title: "Test Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			thread_id: "target-thread",
			message: "   ",
		});

		expect(result).toContain("Error");
		expect(result).toContain("message");
		expect(emittedEvents.length).toBe(0);
	});

	describe("tool schema", () => {
		it("schema has thread_id and message as required params", () => {
			const tool = createNotifyTool(ctx);
			const parameters = tool.toolDefinition.function.parameters as Record<string, unknown>;

			expect(parameters.properties).toBeDefined();
			const properties = parameters.properties as Record<string, unknown>;
			expect(properties.thread_id).toBeDefined();
			expect(properties.message).toBeDefined();

			const required = parameters.required as string[];
			expect(required).toContain("thread_id");
			expect(required).toContain("message");
		});

		it("schema does not contain action, user, or platform params", () => {
			const tool = createNotifyTool(ctx);
			const parameters = tool.toolDefinition.function.parameters as Record<string, unknown>;
			const properties = parameters.properties as Record<string, unknown>;

			expect(properties.action).toBeUndefined();
			expect(properties.user).toBeUndefined();
			expect(properties.platform).toBeUndefined();
		});
	});
});
