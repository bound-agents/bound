import { describe, expect, it } from "bun:test";
import type { StageEntry } from "../summary-extraction";
import { toRelevantMemoryDebug } from "../summary-extraction";

function entry(over: Partial<StageEntry>): StageEntry {
	return {
		key: "k",
		value: "v",
		source: null,
		modifiedAt: "2026-06-01T00:00:00.000Z",
		tier: "default",
		tag: "[recency]",
		...over,
	};
}

describe("toRelevantMemoryDebug", () => {
	it("projects StageEntry[] to the title-only debug shape, dropping the heavy value", () => {
		const got = toRelevantMemoryDebug([
			entry({ key: "a", tier: "pinned", tag: "[graph]", modifiedAt: "2026-06-02T00:00:00.000Z" }),
			entry({ key: "b", tier: "detail", tag: "[recency]" }),
		]);

		expect(got).toEqual([
			{ key: "a", tier: "pinned", tag: "[graph]", modifiedAt: "2026-06-02T00:00:00.000Z" },
			{ key: "b", tier: "detail", tag: "[recency]", modifiedAt: "2026-06-01T00:00:00.000Z" },
		]);
		// The heavy `value` field must not ride into the persisted context_debug row.
		expect(got[0]).not.toHaveProperty("value");
	});

	it("carries the deleted flag so [forgotten] resurfacing is visible for tuning", () => {
		const got = toRelevantMemoryDebug([entry({ key: "gone", deleted: 1 })]);
		expect(got[0].deleted).toBe(1);
	});

	it("omits the deleted key entirely for live entries (keeps rows compact)", () => {
		const got = toRelevantMemoryDebug([entry({ key: "live" })]);
		expect(got[0]).not.toHaveProperty("deleted");
	});

	it("preserves selection order and returns an empty array for no matches", () => {
		expect(toRelevantMemoryDebug([])).toEqual([]);
		const got = toRelevantMemoryDebug([entry({ key: "first" }), entry({ key: "second" })]);
		expect(got.map((e) => e.key)).toEqual(["first", "second"]);
	});
});
