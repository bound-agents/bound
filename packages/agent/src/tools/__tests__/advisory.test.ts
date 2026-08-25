import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createAdvisoryTool } from "../advisory";

describe("advisory tool", () => {
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

	it("creates an advisory with title and detail", async () => {
		const tool = createAdvisoryTool(ctx);
		const result = await tool.execute({
			action: "create",
			title: "Test Advisory",
			detail: "This is a test advisory",
		});

		expect(result).toContain("Advisory created:");
		expect(result).not.toContain("Error");

		// Extract ID from result (format: "Advisory created: <id>")
		const match = result.match(/Advisory created: ([a-f0-9-]+)/);
		expect(match).toBeTruthy();
		const advisoryId = match?.[1];

		// Verify in database
		const row = db
			.prepare("SELECT id, title, detail, status FROM advisories WHERE id = ?")
			.get(advisoryId) as any;
		expect(row).toBeTruthy();
		expect(row.title).toBe("Test Advisory");
		expect(row.detail).toBe("This is a test advisory");
		expect(row.status).toBe("proposed");
	});

	it("stores recommended_action and impact on create", async () => {
		const tool = createAdvisoryTool(ctx);
		const result = await tool.execute({
			action: "create",
			title: "With extras",
			detail: "detail text",
			recommended_action: "restart the daemon",
			impact: "stale schemas served until restart",
		});
		const advisoryId = result.match(/Advisory created: ([a-f0-9-]+)/)?.[1];
		const row = db
			.prepare("SELECT action, impact FROM advisories WHERE id = ?")
			.get(advisoryId) as any;
		expect(row.action).toBe("restart the daemon");
		expect(row.impact).toBe("stale schemas served until restart");
	});

	it("requires title and detail for creation", async () => {
		const tool = createAdvisoryTool(ctx);

		const noTitle = await tool.execute({
			action: "create",
			detail: "Detail without title",
		});
		expect(noTitle).toContain("Error");
		expect(noTitle).toContain("title");

		const noDetail = await tool.execute({
			action: "create",
			title: "Title without detail",
		});
		expect(noDetail).toContain("Error");
		expect(noDetail).toContain("detail");
	});

	it("lists advisories without filters", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create two advisories
		await tool.execute({
			action: "create",
			title: "Advisory 1",
			detail: "Details 1",
		});
		await tool.execute({
			action: "create",
			title: "Advisory 2",
			detail: "Details 2",
		});

		const result = await tool.execute({ action: "list" });
		expect(result).toContain("Advisory 1");
		expect(result).toContain("Advisory 2");
	});

	it("approves an advisory by prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create advisory
		const createResult = await tool.execute({
			action: "create",
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		// Approve it
		const approveResult = await tool.execute({
			action: "approve",
			id: prefix,
			note: "verified against the source thread",
		});
		expect(approveResult).toContain("approved");
		expect(approveResult).not.toContain("Error");

		// Verify status changed
		const row = db.prepare("SELECT status FROM advisories WHERE id = ?").get(advisoryId) as any;
		expect(row.status).toBe("approved");
	});

	it("applies an advisory by prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create and approve advisory
		const createResult = await tool.execute({
			action: "create",
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		await tool.execute({ action: "approve", id: prefix, note: "ok" });
		const applyResult = await tool.execute({ action: "apply", id: prefix, note: "redeployed hub" });

		expect(applyResult).toContain("applied");
		expect(applyResult).not.toContain("Error");

		// Verify status changed
		const row = db.prepare("SELECT status FROM advisories WHERE id = ?").get(advisoryId) as any;
		expect(row.status).toBe("applied");
	});

	it("dismisses an advisory by prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		const createResult = await tool.execute({
			action: "create",
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		const dismissResult = await tool.execute({
			action: "dismiss",
			id: prefix,
			note: "false positive",
		});
		expect(dismissResult).toContain("dismissed");
		expect(dismissResult).not.toContain("Error");

		const row = db.prepare("SELECT status FROM advisories WHERE id = ?").get(advisoryId) as any;
		expect(row.status).toBe("dismissed");
	});

	it("defers an advisory", async () => {
		const tool = createAdvisoryTool(ctx);

		const createResult = await tool.execute({
			action: "create",
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		const deferResult = await tool.execute({
			action: "defer",
			id: prefix,
			note: "snooze until after release",
		});
		expect(deferResult).toContain("deferred");
		expect(deferResult).not.toContain("Error");

		const row = db
			.prepare("SELECT status, defer_until FROM advisories WHERE id = ?")
			.get(advisoryId) as any;
		expect(row.status).toBe("deferred");
		expect(row.defer_until).toBeTruthy();
	});

	// Regression: observed twice — dismiss fell through to create (8 junk
	// advisories minted), and separately list was shadowed by a placeholder
	// title. Under flag-shaped dispatch, create ran whenever title+detail were truthy even
	// when the caller asked for a different operation. Action-enum dispatch
	// makes the operation explicit: stray create-shaped params must never
	// shadow the requested action.
	it("explicit action wins over stray create-shaped params", async () => {
		const tool = createAdvisoryTool(ctx);

		const createResult = await tool.execute({
			action: "create",
			title: "Real Advisory",
			detail: "real detail",
		});
		const advisoryId = createResult.match(/Advisory created: ([a-f0-9-]+)/)?.[1];
		const prefix = advisoryId?.slice(0, 8);
		const before = db.prepare("SELECT COUNT(*) as n FROM advisories").get() as { n: number };

		// dismiss with placeholder title/detail set — must dismiss, not create.
		const dismissResult = await tool.execute({
			action: "dismiss",
			id: prefix,
			title: "x",
			detail: "x",
			note: "cleanup",
		});
		expect(dismissResult).toContain("dismissed");
		expect(dismissResult).not.toContain("created");

		// list with placeholder title/detail set — must list, not create.
		const listResult = await tool.execute({ action: "list", title: "x", detail: "x" });
		expect(listResult).not.toContain("created");

		const after = db.prepare("SELECT COUNT(*) as n FROM advisories").get() as { n: number };
		expect(after.n).toBe(before.n);
	});

	it("state transitions require an id", async () => {
		const tool = createAdvisoryTool(ctx);

		const result = await tool.execute({ action: "approve", note: "ok" });
		expect(result).toContain("Error");
		expect(result).toContain("id");
	});

	it("returns error for ambiguous prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create two advisories
		const create1 = await tool.execute({
			action: "create",
			title: "Advisory A",
			detail: "Details A",
		});
		const create2 = await tool.execute({
			action: "create",
			title: "Advisory B",
			detail: "Details B",
		});

		// Extract IDs
		const id1 = create1.match(/Advisory created: ([a-f0-9-]+)/)?.[1];
		const id2 = create2.match(/Advisory created: ([a-f0-9-]+)/)?.[1];

		if (!id1 || !id2) {
			throw new Error("Failed to extract advisory IDs");
		}

		// Find a common prefix that matches both IDs
		let commonPrefix = "";
		for (let i = 0; i < Math.min(id1.length, id2.length); i++) {
			if (id1[i] === id2[i]) {
				commonPrefix += id1[i];
			} else {
				break;
			}
		}

		// Only run test if we found a common prefix (UUIDs start the same)
		if (commonPrefix.length > 0) {
			const result = await tool.execute({
				action: "approve",
				id: commonPrefix,
				note: "ok",
			});
			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("ambiguous");
		}
	});

	it("returns error for no advisory matching prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		const result = await tool.execute({
			action: "approve",
			id: "nonexistent-prefix",
			note: "ok",
		});
		expect(result).toContain("Error");
		expect(result).toContain("No advisory found");
	});

	it("requires a note for state transitions and stamps resolved_by=agent (#192)", async () => {
		const tool = createAdvisoryTool(ctx);

		const createResult = await tool.execute({
			action: "create",
			title: "Needs a note",
			detail: "details",
		});
		const advisoryId = createResult.match(/Advisory created: ([a-f0-9-]+)/)?.[1];
		const prefix = advisoryId?.slice(0, 8);

		// No note → rejected, status unchanged.
		const noNote = await tool.execute({ action: "approve", id: prefix });
		expect(noNote).toContain("Error");
		expect(noNote.toLowerCase()).toContain("note");
		const stillProposed = db
			.prepare("SELECT status FROM advisories WHERE id = ?")
			.get(advisoryId) as any;
		expect(stillProposed.status).toBe("proposed");

		// Whitespace-only note is treated as missing.
		const blankNote = await tool.execute({ action: "approve", id: prefix, note: "   " });
		expect(blankNote).toContain("Error");

		// With a note → succeeds and stamps provenance.
		const ok = await tool.execute({ action: "approve", id: prefix, note: "verified, merging" });
		expect(ok).not.toContain("Error");
		const row = db
			.prepare("SELECT resolution_note, resolved_by FROM advisories WHERE id = ?")
			.get(advisoryId) as any;
		expect(row.resolution_note).toBe("verified, merging");
		expect(row.resolved_by).toBe("agent");
	});

	it("errors when no action provided", async () => {
		const tool = createAdvisoryTool(ctx);

		const result = await tool.execute({});
		expect(result).toContain("Error");
		expect(result).toContain("action");
	});

	it("filters advisories by status", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create and approve an advisory
		const createResult = await tool.execute({
			action: "create",
			title: "Advisory 1",
			detail: "Details 1",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		await tool.execute({ action: "approve", id: prefix, note: "ok" });

		// Create another (will be proposed)
		await tool.execute({
			action: "create",
			title: "Advisory 2",
			detail: "Details 2",
		});

		// List proposed only
		const listProposed = await tool.execute({
			action: "list",
			list_status: "proposed",
		});
		expect(listProposed).toContain("Advisory 2");
		expect(listProposed).not.toContain("Advisory 1");
	});

	// #93: the tool stamps the originating thread so the web UI can link to it.
	it("stamps ctx.threadId onto created advisories", async () => {
		const tool = createAdvisoryTool({ ...ctx, threadId: "thread-xyz-789" });
		const result = await tool.execute({
			action: "create",
			title: "Thread-linked Advisory",
			detail: "Came from a specific thread",
		});

		const advisoryId = result.match(/Advisory created: ([a-f0-9-]+)/)?.[1];
		expect(advisoryId).toBeTruthy();

		const row = db.prepare("SELECT thread_id FROM advisories WHERE id = ?").get(advisoryId) as {
			thread_id: string | null;
		};
		expect(row.thread_id).toBe("thread-xyz-789");
	});

	it("leaves thread_id NULL when ctx has no threadId", async () => {
		const tool = createAdvisoryTool(ctx);
		const result = await tool.execute({
			action: "create",
			title: "Unlinked Advisory",
			detail: "No thread context",
		});

		const advisoryId = result.match(/Advisory created: ([a-f0-9-]+)/)?.[1];
		const row = db.prepare("SELECT thread_id FROM advisories WHERE id = ?").get(advisoryId) as {
			thread_id: string | null;
		};
		expect(row.thread_id).toBeNull();
	});
});
