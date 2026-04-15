import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { Advisory } from "@bound/shared";
import {
	applyAdvisory,
	approveAdvisory,
	createAdvisory,
	deferAdvisory,
	dismissAdvisory,
	getPendingAdvisories,
	pruneResolvedAdvisories,
} from "../advisories";

describe("Advisories", () => {
	let db: Database.Database;
	const siteId = "test-site";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("should create changelog entry when creating an advisory", () => {
		const advisoryId = createAdvisory(
			db,
			{
				type: "cost",
				title: "Sync test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const changelogEntry = db
			.prepare("SELECT * FROM change_log WHERE table_name = 'advisories' AND row_id = ?")
			.get(advisoryId) as { row_id: string } | null;
		expect(changelogEntry).not.toBeNull();
		expect(changelogEntry?.row_id).toBe(advisoryId);
	});

	it("should create changelog entry when updating advisory status", () => {
		const advisoryId = createAdvisory(
			db,
			{
				type: "cost",
				title: "Sync test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		// Clear changelog from create
		db.prepare("DELETE FROM change_log WHERE row_id = ?").run(advisoryId);

		approveAdvisory(db, advisoryId, siteId);

		const changelogEntries = db
			.prepare("SELECT * FROM change_log WHERE table_name = 'advisories' AND row_id = ?")
			.all(advisoryId);
		expect(changelogEntries.length).toBeGreaterThanOrEqual(1);
	});

	it("should create an advisory", () => {
		const advisoryInput = {
			type: "cost" as const,
			title: "High spending detected",
			detail: "Spending has exceeded threshold",
			action: "Review model usage",
			impact: "medium",
			evidence: "Last 24 hours: $150",
		};

		const advisoryId = createAdvisory(db, advisoryInput, siteId);

		expect(advisoryId).toBeDefined();
		expect(typeof advisoryId).toBe("string");
		expect(advisoryId.length).toBeGreaterThan(0);

		const advisory = db
			.prepare("SELECT * FROM advisories WHERE id = ?")
			.get(advisoryId) as Advisory;
		expect(advisory).toBeDefined();
		expect(advisory.type).toBe("cost");
		expect(advisory.title).toBe("High spending detected");
		expect(advisory.status).toBe("proposed");
		expect(advisory.proposed_at).toBeDefined();
	});

	it("should list pending advisories", () => {
		const id1 = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test 1",
				detail: "Detail 1",
				action: "Action 1",
				impact: "low",
				evidence: "Evidence 1",
			},
			siteId,
		);

		const id2 = createAdvisory(
			db,
			{
				type: "frequency",
				title: "Test 2",
				detail: "Detail 2",
				action: "Action 2",
				impact: "high",
				evidence: "Evidence 2",
			},
			siteId,
		);

		const pending = getPendingAdvisories(db);

		expect(pending.length).toBe(2);
		expect(pending[0].id).toBe(id1);
		expect(pending[1].id).toBe(id2);
	});

	it("should approve an advisory", () => {
		const id = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const result = approveAdvisory(db, id, siteId);
		expect(result.ok).toBe(true);

		const advisory = db.prepare("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
		expect(advisory.status).toBe("approved");
		expect(advisory.resolved_at).toBeDefined();
	});

	it("should dismiss an advisory", () => {
		const id = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const result = dismissAdvisory(db, id, siteId);
		expect(result.ok).toBe(true);

		const advisory = db.prepare("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
		expect(advisory.status).toBe("dismissed");
		expect(advisory.resolved_at).toBeDefined();
	});

	it("should defer an advisory", () => {
		const id = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const result = deferAdvisory(db, id, futureDate, siteId);
		expect(result.ok).toBe(true);

		const advisory = db.prepare("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
		expect(advisory.status).toBe("deferred");
		expect(advisory.defer_until).toBe(futureDate);
	});

	it("should apply an advisory", () => {
		const id = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const result = applyAdvisory(db, id, siteId);
		expect(result.ok).toBe(true);

		const advisory = db.prepare("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory;
		expect(advisory.status).toBe("applied");
		expect(advisory.resolved_at).toBeDefined();
	});

	it("should exclude approved advisories from pending", () => {
		const id1 = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test 1",
				detail: "Detail 1",
				action: "Action 1",
				impact: "low",
				evidence: "Evidence 1",
			},
			siteId,
		);

		const id2 = createAdvisory(
			db,
			{
				type: "frequency",
				title: "Test 2",
				detail: "Detail 2",
				action: "Action 2",
				impact: "high",
				evidence: "Evidence 2",
			},
			siteId,
		);

		approveAdvisory(db, id1, siteId);

		const pending = getPendingAdvisories(db);

		expect(pending.length).toBe(1);
		expect(pending[0].id).toBe(id2);
	});

	it("should exclude dismissed advisories from pending", () => {
		const id1 = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test 1",
				detail: "Detail 1",
				action: "Action 1",
				impact: "low",
				evidence: "Evidence 1",
			},
			siteId,
		);

		const id2 = createAdvisory(
			db,
			{
				type: "frequency",
				title: "Test 2",
				detail: "Detail 2",
				action: "Action 2",
				impact: "high",
				evidence: "Evidence 2",
			},
			siteId,
		);

		dismissAdvisory(db, id1, siteId);

		const pending = getPendingAdvisories(db);

		expect(pending.length).toBe(1);
		expect(pending[0].id).toBe(id2);
	});

	it("should exclude applied advisories from pending", () => {
		const id1 = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test 1",
				detail: "Detail 1",
				action: "Action 1",
				impact: "low",
				evidence: "Evidence 1",
			},
			siteId,
		);

		const id2 = createAdvisory(
			db,
			{
				type: "frequency",
				title: "Test 2",
				detail: "Detail 2",
				action: "Action 2",
				impact: "high",
				evidence: "Evidence 2",
			},
			siteId,
		);

		applyAdvisory(db, id1, siteId);

		const pending = getPendingAdvisories(db);

		expect(pending.length).toBe(1);
		expect(pending[0].id).toBe(id2);
	});

	it("should not include deferred advisories with future dates in pending", () => {
		const id = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		deferAdvisory(db, id, futureDate, siteId);

		const pending = getPendingAdvisories(db);

		expect(pending.length).toBe(0);
	});

	it("should include deferred advisories with past dates in pending", () => {
		const id = createAdvisory(
			db,
			{
				type: "cost",
				title: "Test",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);

		const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		deferAdvisory(db, id, pastDate, siteId);

		const pending = getPendingAdvisories(db);

		expect(pending.length).toBe(1);
		expect(pending[0].id).toBe(id);
	});

	it("should not return soft-deleted advisories from getPendingAdvisories", () => {
		const id = createAdvisory(
			db,
			{
				type: "general",
				status: "proposed",
				title: "Deleted advisory",
				detail: "This was soft-deleted",
				action: null,
				impact: null,
				evidence: null,
			},
			siteId,
		);

		// Soft-delete the advisory
		db.prepare("UPDATE advisories SET deleted = 1 WHERE id = ?").run(id);

		const pending = getPendingAdvisories(db);
		expect(pending.length).toBe(0);
	});
});

describe("pruneResolvedAdvisories", () => {
	let db: Database.Database;
	const siteId = "test-site";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	function makeAdvisory(overrides: Record<string, unknown> = {}): string {
		const id = createAdvisory(
			db,
			{
				type: "general",
				title: (overrides.title as string) ?? "Test advisory",
				detail: "Detail",
				action: null,
				impact: null,
				evidence: null,
			},
			siteId,
		);
		if (overrides.status || overrides.resolved_at) {
			db.run("UPDATE advisories SET status = ?, resolved_at = ?, modified_at = ? WHERE id = ?", [
				overrides.status ?? "proposed",
				overrides.resolved_at ?? null,
				new Date().toISOString(),
				id,
			]);
		}
		return id;
	}

	it("soft-deletes applied advisories older than 7 days", () => {
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const id = makeAdvisory({ status: "applied", resolved_at: eightDaysAgo });

		const { pruned } = pruneResolvedAdvisories(db, siteId);

		expect(pruned).toBe(1);
		const row = db.prepare("SELECT deleted FROM advisories WHERE id = ?").get(id) as {
			deleted: number;
		};
		expect(row.deleted).toBe(1);
	});

	it("does NOT prune applied advisories within 7-day window", () => {
		const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
		makeAdvisory({ status: "applied", resolved_at: oneDayAgo });

		const { pruned } = pruneResolvedAdvisories(db, siteId);
		expect(pruned).toBe(0);
	});

	it("soft-deletes dismissed advisories older than 1 day", () => {
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const id = makeAdvisory({ status: "dismissed", resolved_at: twoDaysAgo });

		const { pruned } = pruneResolvedAdvisories(db, siteId);

		expect(pruned).toBe(1);
		const row = db.prepare("SELECT deleted FROM advisories WHERE id = ?").get(id) as {
			deleted: number;
		};
		expect(row.deleted).toBe(1);
	});

	it("does NOT prune dismissed advisories within 1-day window", () => {
		const halfDayAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
		makeAdvisory({ status: "dismissed", resolved_at: halfDayAgo });

		const { pruned } = pruneResolvedAdvisories(db, siteId);
		expect(pruned).toBe(0);
	});

	it("does NOT prune proposed or deferred advisories", () => {
		makeAdvisory({ status: "proposed" });
		makeAdvisory({ status: "deferred" });

		const { pruned } = pruneResolvedAdvisories(db, siteId);
		expect(pruned).toBe(0);
	});

	it("prunes multiple advisories in one call", () => {
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

		makeAdvisory({ status: "applied", resolved_at: eightDaysAgo });
		makeAdvisory({ status: "applied", resolved_at: eightDaysAgo });
		makeAdvisory({ status: "dismissed", resolved_at: twoDaysAgo });

		const { pruned } = pruneResolvedAdvisories(db, siteId);
		expect(pruned).toBe(3);
	});

	it("uses softDelete (changelog-aware) for synced table compliance", () => {
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const id = makeAdvisory({ status: "applied", resolved_at: eightDaysAgo });

		// Clear changelog from advisory creation
		db.run("DELETE FROM change_log");

		pruneResolvedAdvisories(db, siteId);

		// Verify changelog entry was created by the soft-delete
		const entries = db
			.prepare("SELECT * FROM change_log WHERE table_name = 'advisories' AND row_id = ?")
			.all(id);
		expect(entries.length).toBeGreaterThanOrEqual(1);
	});
});
