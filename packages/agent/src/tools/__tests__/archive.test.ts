import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import type { ToolContext } from "../../types";
import { createArchiveTool } from "../archive";

describe("archive tool", () => {
	let db: Database.Database;
	let ctx: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);

		ctx = {
			db,
			siteId: "test-site",
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

	it("archives a specific thread", async () => {
		const tool = createArchiveTool(ctx);
		const now = new Date().toISOString();

		// Create a thread
		insertRow(
			db,
			"threads",
			{
				id: "thread-1",
				user_id: "user-1",
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
			thread_id: "thread-1",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("archived");

		// Verify thread is soft-deleted
		const row = db.prepare("SELECT deleted FROM threads WHERE id = ?").get("thread-1") as any;
		expect(row.deleted).toBe(1);
	});

	it("returns error when thread not found", async () => {
		const tool = createArchiveTool(ctx);

		const result = await tool.execute({
			thread_id: "nonexistent",
		});

		expect(result).toContain("Error");
		expect(result).toContain("not found");
	});

	it("archives threads older than time offset", async () => {
		const tool = createArchiveTool(ctx);

		// Create old thread (30 days ago)
		const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"threads",
			{
				id: "old-thread",
				user_id: "user-1",
				interface: "web",
				host_origin: "test-host",
				title: "Old Thread",
				created_at: thirtyDaysAgo,
				last_message_at: thirtyDaysAgo,
				modified_at: thirtyDaysAgo,
				deleted: 0,
			},
			ctx.siteId,
		);

		// Create recent thread
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id: "new-thread",
				user_id: "user-1",
				interface: "web",
				host_origin: "test-host",
				title: "New Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			older_than: "7d",
		});

		expect(result).not.toContain("Error");
		expect(result.toLowerCase()).toContain("archived");
		expect(result).toContain("1");

		// Verify only old thread is archived
		const oldRow = db.prepare("SELECT deleted FROM threads WHERE id = ?").get("old-thread") as any;
		expect(oldRow.deleted).toBe(1);

		const newRow = db.prepare("SELECT deleted FROM threads WHERE id = ?").get("new-thread") as any;
		expect(newRow.deleted).toBe(0);
	});

	it("handles week offset", async () => {
		const tool = createArchiveTool(ctx);

		// Create old thread (3 weeks ago)
		const threeWeeksAgo = new Date(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"threads",
			{
				id: "old-thread",
				user_id: "user-1",
				interface: "web",
				host_origin: "test-host",
				title: "Old Thread",
				created_at: threeWeeksAgo,
				last_message_at: threeWeeksAgo,
				modified_at: threeWeeksAgo,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			older_than: "2w",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("1");
	});

	it("handles month offset", async () => {
		const tool = createArchiveTool(ctx);

		// Create old thread (3 months ago)
		const threeMonthsAgo = new Date(Date.now() - 3 * 30 * 24 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"threads",
			{
				id: "old-thread",
				user_id: "user-1",
				interface: "web",
				host_origin: "test-host",
				title: "Old Thread",
				created_at: threeMonthsAgo,
				last_message_at: threeMonthsAgo,
				modified_at: threeMonthsAgo,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			older_than: "2m",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("1");
	});

	it("errors when neither param provided", async () => {
		const tool = createArchiveTool(ctx);

		const result = await tool.execute({});

		expect(result).toContain("Error");
		expect(result.toLowerCase()).toContain("must specify");
	});

	it("returns no matches message when no threads match", async () => {
		const tool = createArchiveTool(ctx);

		// Create recent thread
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id: "new-thread",
				user_id: "user-1",
				interface: "web",
				host_origin: "test-host",
				title: "New Thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);

		const result = await tool.execute({
			older_than: "1d",
		});

		expect(result).not.toContain("Error");
		expect(result).toContain("No threads matched");
	});
});
