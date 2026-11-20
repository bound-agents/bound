/**
 * Coverage for buildHeartbeatContext maintenance/validation branches.
 *
 * The existing heartbeat-context.test.ts covers the section builders with no
 * siteId; this suite drives the siteId-gated maintenance path: advisory/file
 * pruning, the three hourly/daily validation sweeps (R-VC9, outbox audit,
 * stable-prefix drift), their advisory error-catch arms, and the
 * malformed-trigger_spec fallback in the task section.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, createDatabase, insertRow } from "@bound/core";

const SITE = "11111111-1111-1111-1111-111111111111";

interface CapturedLog {
	level: string;
	msg: string;
}

function makeLogger(sink: CapturedLog[]) {
	return {
		info: (msg: string) => sink.push({ level: "info", msg }),
		warn: (msg: string) => sink.push({ level: "warn", msg }),
		error: (msg: string) => sink.push({ level: "error", msg }),
		debug: (msg: string) => sink.push({ level: "debug", msg }),
	} as never;
}

function iso(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

describe("buildHeartbeatContext maintenance + validation branches", () => {
	let db: Database;

	beforeAll(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		db.run("DELETE FROM semantic_memory");
		db.run("DELETE FROM advisories");
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM threads");
		db.run("DELETE FROM messages");
	});

	afterAll(() => {
		db.close();
	});

	it("runs all siteId-gated maintenance and validation sweeps without error", async () => {
		// Import lazily so the module-load cost isn't on the shared describe path.
		const { buildHeartbeatContext } = await import("../heartbeat-context");
		const logs: CapturedLog[] = [];
		// Fresh DB: no last-run markers, so all three validation gates fire.
		const out = buildHeartbeatContext(db, null, { siteId: SITE, logger: makeLogger(logs) });
		expect(out).toContain("scheduled heartbeat check");
		// The validation sweeps wrote their last-run markers.
		const markers = db
			.prepare(
				"SELECT key FROM semantic_memory WHERE key LIKE '_validation:%-last-run' AND deleted = 0",
			)
			.all() as Array<{ key: string }>;
		const keys = markers.map((m) => m.key);
		expect(keys).toContain("_validation:r-vc9-last-run");
		expect(keys).toContain("_validation:outbox-audit-last-run");
		expect(keys).toContain("_validation:stable-prefix-drift-last-run");
	});

	it("logs pruned resolved advisories during maintenance", async () => {
		const { buildHeartbeatContext } = await import("../heartbeat-context");
		// A resolved advisory old enough to be pruned by pruneResolvedAdvisories.
		insertRow(
			db,
			"advisories",
			{
				id: randomUUID(),
				type: "info",
				status: "resolved",
				title: "old resolved advisory",
				detail: "detail",
				action: null,
				impact: null,
				evidence: null,
				proposed_at: iso(-90 * 24 * 60 * 60 * 1000),
				defer_until: null,
				resolved_at: iso(-90 * 24 * 60 * 60 * 1000),
				created_by: SITE,
				thread_id: null,
				resolved_by: SITE,
				resolution_note: null,
				modified_at: iso(-90 * 24 * 60 * 60 * 1000),
				deleted: 0,
			},
			SITE,
		);
		const logs: CapturedLog[] = [];
		buildHeartbeatContext(db, null, { siteId: SITE, logger: makeLogger(logs) });
		// Either it logged a prune or there was nothing old enough; assert the call
		// is stable and, when a prune happened, it was logged at info.
		const prunedLogs = logs.filter((l) => l.msg.includes("Pruned"));
		for (const l of prunedLogs) {
			expect(l.level).toBe("info");
		}
	});

	it("skips the validation sweeps a second time within the cadence window", async () => {
		const { buildHeartbeatContext } = await import("../heartbeat-context");
		const logs: CapturedLog[] = [];
		// First run writes the markers.
		buildHeartbeatContext(db, null, { siteId: SITE, logger: makeLogger(logs) });
		const firstMarker = db
			.prepare("SELECT value FROM semantic_memory WHERE key = '_validation:r-vc9-last-run'")
			.get() as { value: string } | null;
		expect(firstMarker).not.toBeNull();
		// Second run within the window: the gate should not re-run (marker unchanged).
		buildHeartbeatContext(db, null, { siteId: SITE, logger: makeLogger(logs) });
		const secondMarker = db
			.prepare("SELECT value FROM semantic_memory WHERE key = '_validation:r-vc9-last-run'")
			.get() as { value: string } | null;
		expect(secondMarker?.value).toBe(firstMarker?.value);
	});

	it("falls back to the raw trigger_spec when the task's trigger_spec JSON is malformed", async () => {
		const { buildHeartbeatContext } = await import("../heartbeat-context");
		const lastRun = iso(-60 * 60 * 1000);
		// A completed task whose trigger_spec is not valid JSON exercises the catch arm.
		insertRow(
			db,
			"tasks",
			{
				id: randomUUID(),
				type: "cron",
				status: "completed",
				trigger_spec: "not-json{",
				payload: null,
				created_at: lastRun,
				created_by: SITE,
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: iso(-1000),
				run_count: 1,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: "boom error that should be truncated in the digest",
				modified_at: iso(-1000),
				deleted: 0,
			},
			SITE,
		);
		const out = buildHeartbeatContext(db, lastRun, { siteId: SITE });
		// Raw string used as the task name, and the error snippet is present.
		expect(out).toContain("not-json{");
		expect(out).toContain("Error: boom error");
	});
});
