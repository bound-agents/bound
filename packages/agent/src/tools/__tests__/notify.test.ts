import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createNotifyTool } from "../notify";

describe("notify tool", () => {
	let db: Database.Database;
	let ctx: ToolContext;
	let emittedEvents: Array<{ event: string; payload: unknown }> = [];

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
		};
	});

	afterEach(() => {
		db.close();
	});

	it("sends notification to single user", async () => {
		const tool = createNotifyTool(ctx);

		// Create a user
		const userId = deterministicUUID(BOUND_NAMESPACE, "testuser");
		const now = new Date().toISOString();
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Test User",
				platform_ids: JSON.stringify({ discord: "user123" }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		// Create a DM thread for the user on discord
		insertRow(
			db,
			"threads",
			{
				id: "thread-1",
				user_id: userId,
				interface: "discord",
				host_origin: "test-host",
				title: "DM",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			user: "testuser",
			platform: "discord",
			message: "Test notification",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("enqueued");
		expect(emittedEvents.length).toBe(1);
		expect(emittedEvents[0].event).toBe("notify:enqueued");
	});

	it("requires platform and message", async () => {
		const tool = createNotifyTool(ctx);

		const noPlatform = await tool.execute({
			user: "testuser",
			message: "Test",
		});
		expect(noPlatform).toContain("Error");

		const noMessage = await tool.execute({
			user: "testuser",
			platform: "discord",
		});
		expect(noMessage).toContain("Error");
	});

	it("requires either user or all", async () => {
		const tool = createNotifyTool(ctx);

		const result = await tool.execute({
			platform: "discord",
			message: "Test",
		});
		expect(result).toContain("Error");
	});

	it("rejects mutually exclusive user and all", async () => {
		const tool = createNotifyTool(ctx);

		const result = await tool.execute({
			user: "testuser",
			all: true,
			platform: "discord",
			message: "Test",
		});
		expect(result).toContain("Error");
		expect(result.toLowerCase()).toContain("mutually exclusive");
	});

	it("returns error when user not found", async () => {
		const tool = createNotifyTool(ctx);

		const result = await tool.execute({
			user: "nonexistent",
			platform: "discord",
			message: "Test",
		});
		expect(result).toContain("Error");
		expect(result).toContain("not found");
	});

	it("returns error when user has no thread on platform", async () => {
		const tool = createNotifyTool(ctx);

		// Create user but no discord thread
		const userId = deterministicUUID(BOUND_NAMESPACE, "testuser");
		const now = new Date().toISOString();
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Test User",
				platform_ids: JSON.stringify({ discord: "user123" }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			user: "testuser",
			platform: "discord",
			message: "Test",
		});
		expect(result).toContain("Error");
		expect(result.toLowerCase()).toContain("no discord thread found");
	});

	it("broadcasts to all users with platform", async () => {
		const tool = createNotifyTool(ctx);
		const now = new Date().toISOString();

		// Create user 1 with discord
		const userId1 = deterministicUUID(BOUND_NAMESPACE, "user1");
		insertRow(
			db,
			"users",
			{
				id: userId1,
				display_name: "User 1",
				platform_ids: JSON.stringify({ discord: "user1_id" }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);
		insertRow(
			db,
			"threads",
			{
				id: "thread-1",
				user_id: userId1,
				interface: "discord",
				host_origin: "test-host",
				title: "DM",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		// Create user 2 with discord
		const userId2 = deterministicUUID(BOUND_NAMESPACE, "user2");
		insertRow(
			db,
			"users",
			{
				id: userId2,
				display_name: "User 2",
				platform_ids: JSON.stringify({ discord: "user2_id" }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);
		insertRow(
			db,
			"threads",
			{
				id: "thread-2",
				user_id: userId2,
				interface: "discord",
				host_origin: "test-host",
				title: "DM",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		// Create user 3 without discord (will be skipped)
		const userId3 = deterministicUUID(BOUND_NAMESPACE, "user3");
		insertRow(
			db,
			"users",
			{
				id: userId3,
				display_name: "User 3",
				platform_ids: JSON.stringify({ slack: "user3_id" }),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			all: true,
			platform: "discord",
			message: "Broadcast test",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("2");
		expect(result).toContain("enqueued");
		expect(emittedEvents.length).toBe(2);
	});

	it("errors when no threads found in broadcast", async () => {
		const tool = createNotifyTool(ctx);

		// Create user without any platform
		const userId = deterministicUUID(BOUND_NAMESPACE, "user1");
		const now = new Date().toISOString();
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "User 1",
				platform_ids: JSON.stringify({}),
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			all: true,
			platform: "discord",
			message: "Broadcast",
		});

		expect(result).toContain("Error");
		expect(result.toLowerCase()).toContain("no discord threads found");
	});
});
