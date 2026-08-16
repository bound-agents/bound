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

	it("fires for a new thread with sibling summaries", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: null,
				threadLastMessageAt: "2026-07-03T11:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [makeRow()],
			}),
		).toBe(true);
	});

	it("does not fire for a new thread without sibling summaries", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: null,
				threadLastMessageAt: "2026-07-03T11:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [],
			}),
		).toBe(false);
	});

	it("fires for an idle compacted thread when a sibling advanced", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T10:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [makeRow({ summary_through: "2026-07-03T11:00:00.000Z" })],
			}),
		).toBe(true);
	});

	it("does not fire before the idle threshold even when a sibling advanced", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T11:30:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [makeRow({ summary_through: "2026-07-03T11:45:00.000Z" })],
			}),
		).toBe(false);
	});

	it("does not fire at exactly the idle threshold", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
				nowMs: NOW_MS,
				siblingSummaries: [makeRow({ summary_through: new Date(NOW_MS).toISOString() })],
			}),
		).toBe(false);
	});

	it("does not inject an advanced sibling summary into a thread with a recent message", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T11:55:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [makeRow({ summary_through: "2026-07-03T11:58:00.000Z" })],
			}),
		).toBe(false);
	});

	it("does not inject a sibling summary that has not advanced past an idle thread", () => {
		expect(
			shouldInjectCrossThreadSummaries({
				threadSummaryThrough: "2026-07-01T00:00:00.000Z",
				threadLastMessageAt: "2026-07-03T10:00:00.000Z",
				nowMs: NOW_MS,
				siblingSummaries: [makeRow({ summary_through: "2026-07-03T09:00:00.000Z" })],
			}),
		).toBe(false);
	});
});
