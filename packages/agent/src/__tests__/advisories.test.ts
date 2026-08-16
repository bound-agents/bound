import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { Advisory } from "@bound/shared";
import fc from "fast-check";
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

		approveAdvisory(db, advisoryId, { note: "verified, merging", by: "agent" }, siteId);

		const changelogEntries = db
			.prepare("SELECT * FROM change_log WHERE table_name = 'advisories' AND row_id = ?")
			.all(advisoryId);
		expect(changelogEntries.length).toBeGreaterThanOrEqual(1);
	});

	function seed(): string {
		return createAdvisory(
			db,
			{
				type: "cost",
				title: "Seed",
				detail: "Detail",
				action: "Action",
				impact: "low",
				evidence: "Evidence",
			},
			siteId,
		);
	}

	it("preserves terminal resolution fields and excludes resolved advisories from pending", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("approved", "dismissed", "applied"),
				fc.string({ minLength: 1, maxLength: 64 }),
				fc.string({ minLength: 1, maxLength: 128 }),
				fc.array(fc.string({ minLength: 1, maxLength: 32 }), { maxLength: 5 }),
				(status, actor, note, untouchedTitles) => {
					const resolvedId = seed();
					const untouchedIds = untouchedTitles.map((title) =>
						createAdvisory(
							db,
							{
								type: "general",
								title,
								detail: "Detail",
								action: null,
								impact: null,
								evidence: null,
							},
							siteId,
						),
					);

					const resolution = { by: actor, note };
					const result =
						status === "approved"
							? approveAdvisory(db, resolvedId, resolution, siteId)
							: status === "dismissed"
								? dismissAdvisory(db, resolvedId, resolution, siteId)
								: (() => {
										const approved = approveAdvisory(db, resolvedId, resolution, siteId);
										return approved.ok
											? applyAdvisory(db, resolvedId, resolution, siteId)
											: approved;
									})();
					if (!result.ok) return false;

					const row = db
						.prepare(
							"SELECT status, resolution_note, resolved_by, resolved_at FROM advisories WHERE id = ?",
						)
						.get(resolvedId) as Advisory;
					const pendingIds = getPendingAdvisories(db).map((advisory) => advisory.id);
					return (
						row.status === status &&
						row.resolution_note === note &&
						row.resolved_by === actor &&
						row.resolved_at !== null &&
						!pendingIds.includes(resolvedId) &&
						untouchedIds.every((id) => pendingIds.includes(id))
					);
				},
			),
			{ numRuns: 50 },
		);
	});

	it("preserves defer resolution fields", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 64 }),
				fc.string({ minLength: 1, maxLength: 128 }),
				(actor, note) => {
					const id = seed();
					const deferUntil = "2099-01-01T00:00:00.000Z";
					const result = deferAdvisory(db, id, deferUntil, { by: actor, note }, siteId);
					if (!result.ok) return false;
					const row = db
						.prepare(
							"SELECT status, defer_until, resolution_note, resolved_by, resolved_at FROM advisories WHERE id = ?",
						)
						.get(id) as Advisory;
					return (
						row.status === "deferred" &&
						row.defer_until === deferUntil &&
						row.resolution_note === note &&
						row.resolved_by === actor &&
						row.resolved_at === null
					);
				},
			),
			{ numRuns: 50 },
		);
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
		deferAdvisory(db, id, futureDate, { note: "ok", by: "agent" }, siteId);

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

	// #93: advisories carry the originating thread so the web UI can link to it.
	it("persists the originating thread_id when provided", () => {
		const threadId = "thread-abc-123";
		const advisoryId = createAdvisory(
			db,
			{
				type: "general",
				title: "Linked advisory",
				detail: "Detail",
				action: null,
				impact: null,
				evidence: null,
			},
			siteId,
			threadId,
		);

		const row = db.prepare("SELECT thread_id FROM advisories WHERE id = ?").get(advisoryId) as {
			thread_id: string | null;
		};
		expect(row.thread_id).toBe(threadId);
	});

	it("defaults thread_id to NULL when no thread is provided", () => {
		const advisoryId = createAdvisory(
			db,
			{
				type: "general",
				title: "Unlinked advisory",
				detail: "Detail",
				action: null,
				impact: null,
				evidence: null,
			},
			siteId,
		);

		const row = db.prepare("SELECT thread_id FROM advisories WHERE id = ?").get(advisoryId) as {
			thread_id: string | null;
		};
		expect(row.thread_id).toBeNull();
	});
});
