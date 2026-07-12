import { describe, expect, it } from "bun:test";
import type { CrossThreadSummaryRow } from "@bound/core";
import {
	CROSS_THREAD_SUMMARIES_HEADER,
	renderCrossThreadSummaries,
} from "../summary-extraction.js";

describe("renderCrossThreadSummaries", () => {
	it("returns empty lines when no summaries are provided", () => {
		const result = renderCrossThreadSummaries([]);
		expect(result.lines).toEqual([]);
	});

	it("renders a header followed by each thread's title and summary", () => {
		const rows: CrossThreadSummaryRow[] = [
			{
				id: "thread-a",
				title: "Thread A",
				summary: "Summary A content",
				summary_through: "2026-07-02T00:00:00.000Z",
				last_message_at: "2026-07-02T12:00:00.000Z",
			},
			{
				id: "thread-b",
				title: "Thread B",
				summary: "Summary B content",
				summary_through: "2026-07-01T06:00:00.000Z",
				last_message_at: "2026-07-01T08:00:00.000Z",
			},
		];

		const result = renderCrossThreadSummaries(rows);

		expect(result.lines[0]).toBe(CROSS_THREAD_SUMMARIES_HEADER);
		expect(result.lines[1]).toBe("");
		expect(result.lines).toContain("### Thread A");
		expect(result.lines).toContain("Summary A content");
		expect(result.lines).toContain("### Thread B");
		expect(result.lines).toContain("Summary B content");
	});

	it("uses (untitled) for threads with null titles", () => {
		const rows: CrossThreadSummaryRow[] = [
			{
				id: "thread-c",
				title: null,
				summary: "Summary C",
				summary_through: "2026-07-02T00:00:00.000Z",
				last_message_at: "2026-07-02T12:00:00.000Z",
			},
		];

		const result = renderCrossThreadSummaries(rows);
		expect(result.lines).toContain("### (untitled)");
	});

	it("orders sections by the input order (already sorted by last_message_at DESC)", () => {
		const rows: CrossThreadSummaryRow[] = [
			{
				id: "newer",
				title: "Newer Thread",
				summary: "Newer summary",
				summary_through: "2026-07-03T00:00:00.000Z",
				last_message_at: "2026-07-03T12:00:00.000Z",
			},
			{
				id: "older",
				title: "Older Thread",
				summary: "Older summary",
				summary_through: "2026-07-01T00:00:00.000Z",
				last_message_at: "2026-07-01T12:00:00.000Z",
			},
		];

		const result = renderCrossThreadSummaries(rows);

		const newerIdx = result.lines.indexOf("### Newer Thread");
		const olderIdx = result.lines.indexOf("### Older Thread");
		expect(newerIdx).toBeLessThan(olderIdx);
	});
});
