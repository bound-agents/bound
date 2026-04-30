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

	it("requires title and detail for creation", async () => {
		const tool = createAdvisoryTool(ctx);

		const noTitle = await tool.execute({
			detail: "Detail without title",
		});
		expect(noTitle).toContain("Error");
		expect(noTitle).toContain("title");

		const noDetail = await tool.execute({
			title: "Title without detail",
		});
		expect(noDetail).toContain("Error");
		expect(noDetail).toContain("detail");
	});

	it("lists advisories without filters", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create two advisories
		await tool.execute({
			title: "Advisory 1",
			detail: "Details 1",
		});
		await tool.execute({
			title: "Advisory 2",
			detail: "Details 2",
		});

		const result = await tool.execute({ list: true });
		expect(result).toContain("Advisory 1");
		expect(result).toContain("Advisory 2");
	});

	it("approves an advisory by prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create advisory
		const createResult = await tool.execute({
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		// Approve it
		const approveResult = await tool.execute({
			approve: prefix,
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
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		await tool.execute({ approve: prefix });
		const applyResult = await tool.execute({ apply: prefix });

		expect(applyResult).toContain("applied");
		expect(applyResult).not.toContain("Error");

		// Verify status changed
		const row = db.prepare("SELECT status FROM advisories WHERE id = ?").get(advisoryId) as any;
		expect(row.status).toBe("applied");
	});

	it("dismisses an advisory by prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		const createResult = await tool.execute({
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		const dismissResult = await tool.execute({ dismiss: prefix });
		expect(dismissResult).toContain("dismissed");
		expect(dismissResult).not.toContain("Error");

		const row = db.prepare("SELECT status FROM advisories WHERE id = ?").get(advisoryId) as any;
		expect(row.status).toBe("dismissed");
	});

	it("defers an advisory", async () => {
		const tool = createAdvisoryTool(ctx);

		const createResult = await tool.execute({
			title: "Test Advisory",
			detail: "Test details",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		const deferResult = await tool.execute({
			defer: prefix,
		});
		expect(deferResult).toContain("deferred");
		expect(deferResult).not.toContain("Error");

		const row = db
			.prepare("SELECT status, defer_until FROM advisories WHERE id = ?")
			.get(advisoryId) as any;
		expect(row.status).toBe("deferred");
		expect(row.defer_until).toBeTruthy();
	});

	it("returns error for ambiguous prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create two advisories
		const create1 = await tool.execute({
			title: "Advisory A",
			detail: "Details A",
		});
		const create2 = await tool.execute({
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
				approve: commonPrefix,
			});
			expect(result).toContain("Error");
			expect(result.toLowerCase()).toContain("ambiguous");
		}
	});

	it("returns error for no advisory matching prefix", async () => {
		const tool = createAdvisoryTool(ctx);

		const result = await tool.execute({
			approve: "nonexistent-prefix",
		});
		expect(result).toContain("Error");
		expect(result).toContain("No advisory found");
	});

	it("errors when no params provided", async () => {
		const tool = createAdvisoryTool(ctx);

		const result = await tool.execute({});
		expect(result).toContain("Error");
	});

	it("filters advisories by status", async () => {
		const tool = createAdvisoryTool(ctx);

		// Create and approve an advisory
		const createResult = await tool.execute({
			title: "Advisory 1",
			detail: "Details 1",
		});
		const match = createResult.match(/Advisory created: ([a-f0-9-]+)/);
		const advisoryId = match?.[1];
		const prefix = advisoryId.slice(0, 8);

		await tool.execute({ approve: prefix });

		// Create another (will be proposed)
		await tool.execute({
			title: "Advisory 2",
			detail: "Details 2",
		});

		// List proposed only
		const listProposed = await tool.execute({
			list: true,
			list_status: "proposed",
		});
		expect(listProposed).toContain("Advisory 2");
		expect(listProposed).not.toContain("Advisory 1");
	});
});
