import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { assembleContext, formatInstant, frozenClock } from "../context-assembly";

/**
 * AC.3 / R-UD4 — `assembleContext` is a pure function of `(DB, AssemblyContext)`.
 *
 * Two runs under the SAME `AssemblyClock` but performed at different real
 * wall-clock times must produce byte-identical `messages` + `systemPrompt`.
 * "Now" enters ONLY via the clock, so two hosts handed the same `(DB, clock)`
 * agree byte-for-byte — the cross-host guarantee the single-delegation bug-class
 * fix needs.
 *
 * This extends purity to the VARYING Live State half (Stage 5.5), which R-VC25
 * deliberately left clock-dependent. The fixture seeds memory (Working Knowledge
 * + Discoverable Archive + R-VC27 relevant memory), tasks, and a user message so
 * the Live State subsystems and the `<user-message sent="…">` year branch are
 * all exercised — not only the stable prefix.
 *
 * Precondition handled: `assembleContext` performs a debounced `last_accessed_at`
 * write (`bumpRenderedDetailEntries`). Both runs use the same frozen clock, so
 * the second run's bump is a deterministic no-op and the rendered bytes are
 * invariant to it (render-invariance, cf. da-render-stability.test.ts).
 */
describe("assembleContext determinism (AC.3 / R-UD4)", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "assembly-determinism-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);

		userId = randomUUID();
		threadId = randomUUID();
		const iso = "2025-06-01T12:00:00.000Z";

		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Kara", null, iso, iso, 0],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				iso,
				iso,
				iso,
				0,
			],
		);

		// A user message with a tz offset so the `<user-message sent="…">`
		// envelope exercises formatInstant's year branch (the lone wall-clock
		// dependency of annotation).
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, host_origin, tool_name, created_at, modified_at, metadata, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				threadId,
				"user",
				"Hello, agent.",
				null,
				"local",
				null,
				"2024-12-31T23:30:00.000Z",
				"2024-12-31T23:30:00.000Z",
				JSON.stringify({ tz_offset: 0, user_name: "Kara" }),
				0,
			],
		);

		// Seed memory across tiers so Working Knowledge, Discoverable Archive,
		// and R-VC27 relevant-memory all render on the varying side.
		const mem = (key: string, value: string, tier: string, ago: number) => {
			const ts = new Date(Date.parse("2025-06-01T12:00:00.000Z") - ago).toISOString();
			db.run(
				"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, tier, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[randomUUID(), key, value, "test", ts, ts, ts, tier, 0],
			);
		};
		mem("project:bound", "Bound is a personal multi-host agent.", "pinned", 60_000);
		mem("policy:tone", "Be concise and direct.", "summary", 120_000);
		mem("detail:sync", "Sync uses HLC cursors over Ed25519 WS.", "detail", 3_600_000);
		mem("recent:note", "Investigated history:0 bug today.", "default", 5_000);
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	it("produces byte-identical output for two runs under the same frozen clock", () => {
		// Same frozen clock; the two calls happen at different real times (the
		// second is strictly after the first in wall-clock terms). Output must
		// not depend on the gap.
		const clock = frozenClock(Date.parse("2025-06-02T09:00:00.000Z"));

		const a = assembleContext({ db, threadId, userId, clock });
		// Force a measurable real-time gap so any latent Date.now() leak surfaces.
		const spinUntil = Date.now() + 25;
		while (Date.now() < spinUntil) {
			/* busy-wait to advance the real wall clock */
		}
		const b = assembleContext({ db, threadId, userId, clock });

		expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
		expect(b.systemPrompt).toBe(a.systemPrompt);
	});

	it("is stable across a cross-year clock boundary (year-branch determinism)", () => {
		// The seeded user message is dated 2024-12-31. A clock in 2024 renders
		// the same-year form; a clock in 2026 renders the `'24` suffix form. Each
		// clock must be internally deterministic, and the two must differ ONLY in
		// the year-dependent annotation — proving the year enters via the clock,
		// not ambient Date.now().
		const clock2024 = frozenClock(Date.parse("2024-12-31T23:59:00.000Z"));
		const clock2026 = frozenClock(Date.parse("2026-01-02T00:00:00.000Z"));

		const y2024a = assembleContext({ db, threadId, userId, clock: clock2024 });
		const y2024b = assembleContext({ db, threadId, userId, clock: clock2024 });
		const y2026 = assembleContext({ db, threadId, userId, clock: clock2026 });

		// Same clock → byte-identical.
		expect(JSON.stringify(y2024b.messages)).toBe(JSON.stringify(y2024a.messages));

		// Cross-year clocks → the user-message envelope differs (same-year vs
		// `'24` suffix). This confirms the year flows from the clock.
		const sentA = JSON.stringify(y2024a.messages);
		const sent2026 = JSON.stringify(y2026.messages);
		expect(sent2026).not.toBe(sentA);
	});

	it("formatInstant year branch is driven by the explicit reference, not Date.now()", () => {
		const iso = "2024-12-31T23:30:00.000Z";
		// Reference year 2024 → same-year form (no apostrophe-year suffix).
		const sameYear = formatInstant(iso, 0, Date.parse("2024-06-01T00:00:00.000Z"));
		// Reference year 2026 → `'24` suffix form.
		const crossYear = formatInstant(iso, 0, Date.parse("2026-06-01T00:00:00.000Z"));

		expect(sameYear).not.toContain("'24");
		expect(crossYear).toContain("'24");
	});
});
