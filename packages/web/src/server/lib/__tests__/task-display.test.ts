import { describe, expect, it } from "bun:test";
import type { Task } from "@bound/shared";
import { extractDisplayName, extractSchedule } from "../task-display";

// extractDisplayName / extractSchedule turn a raw task row into the two
// UI-facing strings the task card shows. These tests cover every task type,
// the payload-parse fallbacks, and each human-readable cron/interval mapping
// so the private formatting helpers are exercised too.

function task(overrides: Partial<Task>): Task {
	return {
		id: "0123abcd-ef01-2345-6789-abcdef012345",
		type: "cron",
		status: "pending",
		trigger_spec: "0 * * * *",
		payload: null,
		created_at: "2026-07-04T00:00:00.000Z",
		created_by: "site",
		thread_id: null,
		origin_thread_id: null,
		claimed_by: null,
		claimed_at: null,
		lease_id: null,
		next_run_at: null,
		last_run_at: null,
		run_count: 0,
		max_runs: null,
		requires: null,
		model_hint: null,
		no_history: 0,
		inject_mode: "results",
		depends_on: null,
		require_success: 0,
		alert_threshold: 3,
		consecutive_failures: 0,
		event_depth: 0,
		no_quiescence: 0,
		system_prompt_addition: null,
		heartbeat_at: null,
		result: null,
		error: null,
		modified_at: "2026-07-04T00:00:00.000Z",
		deleted: 0,
		...overrides,
	} as Task;
}

describe("extractDisplayName", () => {
	it("returns the literal 'heartbeat' for heartbeat tasks", () => {
		expect(extractDisplayName(task({ type: "heartbeat" }))).toBe("heartbeat");
	});

	it("uses the cron payload name when present", () => {
		expect(
			extractDisplayName(
				task({ type: "cron", payload: JSON.stringify({ name: "nightly sweep" }) }),
			),
		).toBe("nightly sweep");
	});

	it("uses the deferred payload description when present", () => {
		expect(
			extractDisplayName(
				task({ type: "deferred", payload: JSON.stringify({ description: "one-shot cleanup" }) }),
			),
		).toBe("one-shot cleanup");
	});

	it("falls back to 'type id8' when the cron payload has no name", () => {
		const t = task({ type: "cron", payload: JSON.stringify({ other: 1 }) });
		expect(extractDisplayName(t)).toBe(`cron ${t.id.slice(0, 8)}`);
	});

	it("falls back when the payload is malformed JSON", () => {
		const t = task({ type: "cron", payload: "{not json" });
		expect(extractDisplayName(t)).toBe(`cron ${t.id.slice(0, 8)}`);
	});

	it("falls back for a deferred task with no payload", () => {
		const t = task({ type: "deferred", payload: null });
		expect(extractDisplayName(t)).toBe(`deferred ${t.id.slice(0, 8)}`);
	});

	it("falls back for an event task (no name channel)", () => {
		const t = task({ type: "event" });
		expect(extractDisplayName(t)).toBe(`event ${t.id.slice(0, 8)}`);
	});
});

describe("extractSchedule", () => {
	it("returns 'one-time' for deferred tasks", () => {
		expect(extractSchedule(task({ type: "deferred" }))).toBe("one-time");
	});

	it("returns 'on-event' for event tasks", () => {
		expect(extractSchedule(task({ type: "event" }))).toBe("on-event");
	});

	it("returns null for an unrecognized type", () => {
		expect(extractSchedule(task({ type: "mystery" as Task["type"] }))).toBeNull();
	});

	it("returns null when a cron task has no trigger spec", () => {
		expect(extractSchedule(task({ type: "cron", trigger_spec: "" }))).toBeNull();
	});

	describe("human-readable cron expressions", () => {
		const cases: Array<[string, string]> = [
			["*/15 * * * *", "every 15m"],
			["*/30 * * * *", "every 30m"],
			["0 * * * *", "hourly"],
			["*/5 * * * *", "every 5m"],
			["*/10 * * * *", "every 10m"],
			["0 0 * * *", "daily"],
			["0 0 1 * *", "monthly"],
			["0 0 * * 1", "weekly"],
		];
		for (const [spec, expected] of cases) {
			it(`maps '${spec}' to '${expected}'`, () => {
				expect(extractSchedule(task({ type: "cron", trigger_spec: spec }))).toBe(expected);
			});
		}

		it("returns the raw spec for an unrecognized 5-field cron", () => {
			expect(extractSchedule(task({ type: "cron", trigger_spec: "7 3 * * *" }))).toBe("7 3 * * *");
		});

		it("returns the raw spec when it has the wrong field count", () => {
			expect(extractSchedule(task({ type: "cron", trigger_spec: "0 0" }))).toBe("0 0");
		});
	});

	describe("JSON-wrapped trigger specs", () => {
		it("renders an interval_ms under an hour as minutes", () => {
			expect(
				extractSchedule(
					task({ type: "cron", trigger_spec: JSON.stringify({ interval_ms: 300_000 }) }),
				),
			).toBe("every 5m");
		});

		it("renders an interval_ms of exact hours", () => {
			expect(
				extractSchedule(
					task({ type: "cron", trigger_spec: JSON.stringify({ interval_ms: 2 * 3_600_000 }) }),
				),
			).toBe("every 2h");
		});

		it("renders a mixed hours+minutes interval", () => {
			expect(
				extractSchedule(
					task({
						type: "cron",
						trigger_spec: JSON.stringify({ interval_ms: 90 * 60_000 }),
					}),
				),
			).toBe("every 1h 30m");
		});

		it("renders a sub-minute interval as 'every <1m'", () => {
			expect(
				extractSchedule(
					task({ type: "cron", trigger_spec: JSON.stringify({ interval_ms: 1000 }) }),
				),
			).toBe("every <1m");
		});

		it("unwraps an 'expression' field to a cron expression", () => {
			expect(
				extractSchedule(
					task({ type: "cron", trigger_spec: JSON.stringify({ expression: "0 0 * * *" }) }),
				),
			).toBe("daily");
		});

		it("unwraps a 'cron' field", () => {
			expect(
				extractSchedule(
					task({ type: "cron", trigger_spec: JSON.stringify({ cron: "0 * * * *" }) }),
				),
			).toBe("hourly");
		});

		it("unwraps a 'schedule' field", () => {
			expect(
				extractSchedule(
					task({ type: "cron", trigger_spec: JSON.stringify({ schedule: "*/15 * * * *" }) }),
				),
			).toBe("every 15m");
		});

		it("treats a non-JSON spec starting with { as a raw cron expression", () => {
			// Starts with '{' but is not valid JSON — the catch falls through and
			// humanReadableCron receives the raw string.
			expect(extractSchedule(task({ type: "cron", trigger_spec: "{bogus" }))).toBe("{bogus");
		});

		it("falls through to the raw spec when the JSON has no recognized field", () => {
			const spec = JSON.stringify({ unrelated: true });
			expect(extractSchedule(task({ type: "cron", trigger_spec: spec }))).toBe(spec);
		});
	});
});
