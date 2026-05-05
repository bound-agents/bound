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

	describe("thread action", () => {
		it("AC1.1: enqueues notification for valid thread_id", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();

			// Insert a valid target thread
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
				action: "thread",
				thread_id: "target-thread",
				message: "Hello",
			});

			// Verify success response
			expect(result).not.toContain("Error");
			expect(result).toContain("enqueued");

			// Verify event was emitted
			expect(emittedEvents.length).toBe(1);
			expect(emittedEvents[0].event).toBe("notify:enqueued");
			expect(emittedEvents[0].payload).toEqual({ thread_id: "target-thread" });

			// Verify dispatch_queue has an entry
			const queueEntry = db
				.prepare("SELECT message_id FROM dispatch_queue WHERE thread_id = ? LIMIT 1")
				.get("target-thread") as { message_id: string } | null;
			expect(queueEntry).not.toBeNull();
		});

		it("AC1.2: returns error when thread_id is missing", async () => {
			const tool = createNotifyTool(ctx);

			const result = await tool.execute({
				action: "thread",
				message: "Hello",
			} as any);

			expect(result).toContain("Error");
			expect(result).toContain("thread_id");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC1.3: returns error for non-existent thread", async () => {
			const tool = createNotifyTool(ctx);

			const result = await tool.execute({
				action: "thread",
				thread_id: "nonexistent",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC1.3: returns error for soft-deleted thread", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();

			// Insert a thread and then soft-delete it
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
				action: "thread",
				thread_id: "deleted-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC1.4: returns error for self-notify (thread_id matches current thread)", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();

			// Insert the current thread
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
				action: "thread",
				thread_id: "current-thread",
				message: "Hello",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("current thread");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC1.5: returns error for empty or whitespace-only message", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();

			// Insert a valid thread
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
				action: "thread",
				thread_id: "target-thread",
				message: "   ",
			});

			expect(result).toContain("Error");
			expect(result).toContain("message");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("user action", () => {
		it("AC2.1: resolves DM thread and enqueues notification for valid user", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();
			const userId = deterministicUUID(BOUND_NAMESPACE, "alice");

			// Insert user
			insertRow(
				db,
				"users",
				{
					id: userId,
					display_name: "Alice",
					platform_ids: JSON.stringify({ discord: "alice-discord-id" }),
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			// Insert DM thread with discord interface
			insertRow(
				db,
				"threads",
				{
					id: "alice-dm-thread",
					user_id: userId,
					interface: "discord",
					host_origin: "test-host",
					title: "Alice DM",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			const result = await tool.execute({
				action: "user",
				user: "alice",
				platform: "discord",
				message: "Hey",
			});

			expect(result).not.toContain("Error");
			expect(emittedEvents.length).toBe(1);
			expect(emittedEvents[0].event).toBe("notify:enqueued");
		});

		it("AC2.2: returns error when user is missing", async () => {
			const tool = createNotifyTool(ctx);

			const result = await tool.execute({
				action: "user",
				platform: "discord",
				message: "Hey",
			} as any);

			expect(result).toContain("Error");
			expect(result).toContain("user");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC2.2: returns error when platform is missing", async () => {
			const tool = createNotifyTool(ctx);

			const result = await tool.execute({
				action: "user",
				user: "alice",
				message: "Hey",
			} as any);

			expect(result).toContain("Error");
			expect(result).toContain("platform");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC2.3: returns error for non-existent username", async () => {
			const tool = createNotifyTool(ctx);

			const result = await tool.execute({
				action: "user",
				user: "ghost",
				platform: "discord",
				message: "Hey",
			});

			expect(result).toContain("Error");
			expect(result).toContain("not found");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC2.4: returns error when user exists but has no DM thread on platform", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();
			const userId = deterministicUUID(BOUND_NAMESPACE, "alice");

			// Insert user but NO thread with discord interface
			insertRow(
				db,
				"users",
				{
					id: userId,
					display_name: "Alice",
					platform_ids: JSON.stringify({ discord: "alice-discord-id" }),
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			const result = await tool.execute({
				action: "user",
				user: "alice",
				platform: "discord",
				message: "Hey",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("discord");
			expect(emittedEvents.length).toBe(0);
		});

		it("AC2.5: returns error for self-notify via resolved thread", async () => {
			const tool = createNotifyTool(ctx);
			const now = new Date().toISOString();
			const userId = deterministicUUID(BOUND_NAMESPACE, "alice");

			// Insert user
			insertRow(
				db,
				"users",
				{
					id: userId,
					display_name: "Alice",
					platform_ids: JSON.stringify({ discord: "alice-discord-id" }),
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			// Insert thread with id matching current thread (self-notify case)
			insertRow(
				db,
				"threads",
				{
					id: "current-thread",
					user_id: userId,
					interface: "discord",
					host_origin: "test-host",
					title: "Alice DM",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);

			const result = await tool.execute({
				action: "user",
				user: "alice",
				platform: "discord",
				message: "Hey",
			});

			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("current thread");
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe("tool schema (AC3)", () => {
		it("AC3.1: tool schema exposes action as required enum with values [thread, user]", () => {
			const tool = createNotifyTool(ctx);

			// Access the tool definition
			const parameters = tool.toolDefinition.function.parameters as Record<string, unknown>;

			// Verify action parameter exists and is an enum
			expect(parameters.properties).toBeDefined();
			const actionParam = (parameters.properties as Record<string, unknown>).action as Record<
				string,
				unknown
			>;
			expect(actionParam).toBeDefined();
			expect(actionParam.enum).toEqual(["thread", "user"]);

			// Verify action is required
			expect(parameters.required).toBeDefined();
			const required = parameters.required as string[];
			expect(required).toContain("action");
		});

		it("AC3.3: tool schema does not contain an 'all' parameter", () => {
			const tool = createNotifyTool(ctx);

			const parameters = tool.toolDefinition.function.parameters as Record<string, unknown>;
			expect(parameters.properties).toBeDefined();

			const properties = parameters.properties as Record<string, unknown>;
			expect(properties.all).toBeUndefined();
		});

		it("AC3.3: calling execute with all=true does not trigger broadcast or error", async () => {
			const tool = createNotifyTool(ctx);

			// Call with all=true and no action — should either error or silently ignore
			const result = await tool.execute({
				all: true,
				message: "Test broadcast",
			} as any);

			// Should error because action is required, not because all is invalid
			expect(result).toContain("Error");
			expect(emittedEvents.length).toBe(0);
		});
	});
});
