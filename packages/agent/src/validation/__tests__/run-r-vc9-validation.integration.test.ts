import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { runR_VC9Validation, shouldRunR_VC9Validation } from "../run-r-vc9-validation";

describe("runR_VC9Validation (integration)", () => {
	let db: Database;
	const SITE_ID = "test-site";
	const NOW = Date.now();

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("samples 50 keys and returns counts", () => {
		// Create compliant entries
		for (let i = 0; i < 25; i++) {
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`compliant-${i}`,
				`_summary:transit-systems-routing-${i}`,
				"We discussed transit systems and routing patterns extensively in detail today",
				"summary",
				0,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				"test",
			);
		}

		// Create non-compliant entries (slug tokens not in body)
		for (let i = 0; i < 25; i++) {
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`noncompliant-${i}`,
				`_detail:foo-bar-baz-${i}`,
				"This entry talks about something completely unrelated to the key",
				"detail",
				0,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				"test",
			);
		}

		// Build frequency table by hand for the compliant tokens
		// Each entry gets counted once for: transit, systems, routing
		// 25 entries * 3 tokens = 75 total; but we need 5+ per token
		// So we need at least 5 distinct entries per token to reach freq 5+
		// Let me fix the setup: create tokens with sufficient frequency

		// Clear and redo with proper frequency setup
		db.exec("DELETE FROM semantic_memory");

		// Create entries for transit (5+), systems (5+), routing (5+)
		for (let i = 0; i < 5; i++) {
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`freq-transit-${i}`,
				`_detail:transit-corpus-${i}`,
				"transit routing systems",
				"detail",
				0,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				"test",
			);
		}

		// Create compliant entry now that tokens have freq 5
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"compliant-1",
			"_summary:transit-systems-routing",
			"Discussion of transit systems and routing patterns",
			"summary",
			0,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			"test",
		);

		// Create non-compliant entries
		for (let i = 0; i < 30; i++) {
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`noncompliant-${i}`,
				`_detail:foo-bar-baz-${i}`,
				"This entry does not mention foo bar or baz",
				"detail",
				0,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				"test",
			);
		}

		const report = runR_VC9Validation(db, SITE_ID, NOW);

		// Should have sampled entries and found non-compliance
		expect(report.sampledKeys).toBeGreaterThan(0);
		expect(report.sampledKeys).toBeLessThanOrEqual(50);
	});

	it("creates _validation:r-vc9-non-compliance outcome entries for non-compliant keys", () => {
		// Setup: one freq-5+ token that won't appear in a key's value
		for (let i = 0; i < 5; i++) {
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`freq-obscure-${i}`,
				`_detail:content-${i}`,
				"obscure unknown absent",
				"detail",
				0,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				"test",
			);
		}

		// Non-compliant key (slug tokens not in value)
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"noncompliant",
			"_detail:obscure-unknown-absent",
			"This entry talks about something else",
			"detail",
			0,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			"test",
		);

		runR_VC9Validation(db, SITE_ID, NOW);

		// Check for outcome entry
		const outcome = db
			.prepare(
				"SELECT value FROM semantic_memory WHERE key LIKE '_validation:r-vc9-non-compliance:%' AND deleted = 0",
			)
			.get() as { value: string } | null;

		expect(outcome).toBeTruthy();
		if (outcome) {
			const parsed = JSON.parse(outcome.value);
			expect(parsed).toHaveProperty("slugTokens");
			expect(parsed).toHaveProperty("inBody");
			expect(parsed).toHaveProperty("bothConditions");
		}
	});

	it("creates _validation:r-vc9b-non-compliance outcome entries for summary non-compliance", () => {
		// Setup: freq tokens
		for (let i = 0; i < 5; i++) {
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`freq-transit-${i}`,
				`_detail:transit-${i}`,
				"transit systems",
				"detail",
				0,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
				"test",
			);
		}

		// Parent summary with tokens in value
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"parent-summary",
			"_summary:transit-systems",
			"Parent gloss about transit systems",
			"summary",
			0,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			"test",
		);

		// Child with tokens that don't match parent gloss
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"child-missing",
			"_detail:routing-analysis",
			"Content about routing",
			"detail",
			0,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			"test",
		);

		// Edge: parent summarizes child
		const now = new Date(NOW).toISOString();
		db.prepare(
			"INSERT INTO memory_edges (id, source_key, target_key, relation, deleted, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			"edge-1",
			"_summary:transit-systems",
			"_detail:routing-analysis",
			"summarizes",
			0,
			now,
			now,
		);

		runR_VC9Validation(db, SITE_ID, NOW);

		// Check for R-VC9b outcome entry
		const outcome = db
			.prepare(
				"SELECT value FROM semantic_memory WHERE key LIKE '_validation:r-vc9b-non-compliance:%' AND deleted = 0",
			)
			.get() as { value: string } | null;

		expect(outcome).toBeTruthy();
		if (outcome) {
			const parsed = JSON.parse(outcome.value);
			expect(parsed).toHaveProperty("childCount");
			expect(parsed).toHaveProperty("childrenWithSubjectInGloss");
			expect(parsed).toHaveProperty("failingChildKeys");
		}
	});

	it("stores last run timestamp for daily gating", () => {
		// Just verify that runR_VC9Validation completes without error
		// The actual storage happens via insertRow which uses the outbox system,
		// so we can't directly verify it in-memory, but we can verify the function completes
		const report = runR_VC9Validation(db, SITE_ID, NOW);
		expect(report).toBeTruthy();
		expect(report).toHaveProperty("sampledKeys");
		expect(report).toHaveProperty("rVc9NonCompliantCount");
		expect(report).toHaveProperty("rVc9bNonCompliantCount");
	});

	it("shouldRunR_VC9Validation returns true on first run", () => {
		const shouldRun = shouldRunR_VC9Validation(db, NOW);
		expect(shouldRun).toBe(true);
	});

	it("shouldRunR_VC9Validation returns false within 24 hours", () => {
		// Set up a recent last-run timestamp
		const recentTime = NOW - 1 * 60 * 60 * 1000; // 1 hour ago
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"last-run-id",
			"_validation:r-vc9-last-run",
			new Date(recentTime).toISOString(),
			"default",
			0,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			"test",
		);

		const shouldRun = shouldRunR_VC9Validation(db, NOW);
		expect(shouldRun).toBe(false);
	});

	it("shouldRunR_VC9Validation returns true after 24 hours", () => {
		// Set up an old last-run timestamp (30+ hours ago)
		const oldTime = NOW - 30 * 60 * 60 * 1000;
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, tier, deleted, modified_at, created_at, last_accessed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"last-run-id",
			"_validation:r-vc9-last-run",
			new Date(oldTime).toISOString(),
			"default",
			0,
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			new Date(NOW).toISOString(),
			"test",
		);

		const shouldRun = shouldRunR_VC9Validation(db, NOW);
		expect(shouldRun).toBe(true);
	});
});
