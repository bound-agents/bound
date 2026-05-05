import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow, softDelete } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createIntrospectTool } from "../introspect";

describe("introspect tool", () => {
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

	describe("AC1.1: Valid thread_id and message accepted", () => {
		it("enqueues notification and returns correlation_id", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert target thread
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
				message: "What do you think about this?",
			});

			// Should not contain "Error"
			expect(result).not.toContain("Error");

			// Should contain correlation info
			expect(result).toContain("correlation");

			// Event should be emitted
			expect(emittedEvents.length).toBe(1);
			expect(emittedEvents[0].event).toBe("notify:enqueued");
			expect(emittedEvents[0].payload).toEqual({ thread_id: "target-thread" });

			// Check dispatch_queue has entry
			const queueEntry = db
				.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ? LIMIT 1")
				.get("target-thread") as { event_payload: string } | null;
			expect(queueEntry).not.toBeNull();

			// Verify payload structure
			const payload = JSON.parse(queueEntry?.event_payload || "{}");
			expect(payload.type).toBe("introspect");
			expect(payload.correlation_id).toBeDefined();
			expect(payload.source_thread).toBe("current-thread");
			expect(payload.content).toBe("What do you think about this?");
		});
	});

	describe("AC1.2: Missing or empty thread_id returns error", () => {
		it("returns error when thread_id is missing", async () => {
			const tool = createIntrospectTool(ctx);

			const result = await tool.execute({
				message: "Hello",
			} as any);

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("thread_id");
			expect(emittedEvents.length).toBe(0);
		});

		it("returns error when thread_id is empty string", async () => {
			const tool = createIntrospectTool(ctx);

			const result = await tool.execute({
				thread_id: "",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("AC1.3: Self-introspect guard", () => {
		it("returns error when target thread is current thread", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert current thread
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
			expect(result.toLowerCase()).toContain("self");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("AC1.4: Thread not found or deleted returns error", () => {
		it("returns error when thread does not exist", async () => {
			const tool = createIntrospectTool(ctx);

			const result = await tool.execute({
				thread_id: "nonexistent-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("not found");
			expect(emittedEvents.length).toBe(0);
		});

		it("returns error when thread is soft-deleted", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert thread
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

			// Soft-delete it
			softDelete(db, "threads", "deleted-thread", ctx.siteId);

			const result = await tool.execute({
				thread_id: "deleted-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("deleted");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("AC2.1: Notification payload structure", () => {
		it("payload contains type=introspect, correlation_id, source_thread, and content", async () => {
			const tool = createIntrospectTool(ctx);
			const now = new Date().toISOString();

			// Insert target thread
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

			await tool.execute({
				thread_id: "target-thread",
				message: "Introspect this for me",
			});

			// Query dispatch_queue
			const queueEntry = db
				.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ? LIMIT 1")
				.get("target-thread") as { event_payload: string } | null;

			expect(queueEntry).not.toBeNull();

			const payload = JSON.parse(queueEntry?.event_payload || "{}");
			expect(payload.type).toBe("introspect");
			expect(typeof payload.correlation_id).toBe("string");
			expect(payload.correlation_id.length).toBeGreaterThan(0);
			expect(payload.source_thread).toBe("current-thread");
			expect(payload.content).toBe("Introspect this for me");
		});
	});
});
