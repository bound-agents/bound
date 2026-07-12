import { describe, expect, it } from "bun:test";
import type { CrossThreadSummaryRow } from "@bound/core";
import { shouldInjectCrossThreadSummaries } from "../summary-extraction.js";

function makeRow(overrides: Partial<CrossThreadSummaryRow> = {}): CrossThreadSummaryRow {
	return {
		id: "sibling-a",
		title: "Thread A",
		summary: "Summary A",
		summary_through: "2026-07-02T00:00:00.000Z",
		last_message_at: "2026-07-02T12:00:00.000Z",
		...overrides,
	};
}

describe("shouldInjectCrossThreadSummaries", () => {
	const NOW_MS = new Date("2026-07-03T12:00:00.000Z").getTime();

	it("Scenario A: fires for a new thread with no compaction when siblings exist", () => {
		const rows = [makeRow()];
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: null,
				threadLastMessageAt: "2026-07-03T11:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: rows,
			}),
		).toBe(true);
	});

	it("Scenario A: does not fire for a new thread when no siblings have summaries", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: null,
				threadLastMessageAt: "2026-07-03T11:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [],
			}),
		).toBe(false);
	});

	it("Scenario B: fires when idle > 1h and a sibling summary advanced past last activity", () => {
		// Thread was last active at 10:00, now is 12:00 (2h idle)
		// Sibling's summary_through is 11:00 — advanced past 10:00
		const rows = [makeRow({ summary_through: "2026-07-03T11:00:00.000Z" })];
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T10:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: rows,
			}),
		).toBe(true);
	});

	it("Scenario B: does not fire when idle < 1h even if sibling advanced", () => {
		// Thread was last active at 11:30, now is 12:00 (30min idle < 1h)
		const rows = [makeRow({ summary_through: "2026-07-03T11:45:00.000Z" })];
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T11:30:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: rows,
			}),
		).toBe(false);
	});

	it("Scenario B: does not fire when idle > 1h but no sibling advanced past last activity", () => {
		// Thread was last active at 10:00, now is 12:00 (2h idle)
		// But sibling's summary_through is 09:00 — before the thread's last activity
		const rows = [makeRow({ summary_through: "2026-07-03T09:00:00.000Z" })];
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T10:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: rows,
			}),
		).toBe(false);
	});

	it("Scenario B: does not fire when idle > 1h but no siblings exist", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T10:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [],
			}),
		).toBe(false);
	});

	it("does not fire for a compacted thread that is actively in conversation", () => {
		// Thread has been compacted (summary_through set), last message was 5 min ago
		const rows = [makeRow({ summary_through: "2026-07-03T11:58:00.000Z" })];
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T11:55:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: rows,
			}),
		).toBe(false);
	});
});
