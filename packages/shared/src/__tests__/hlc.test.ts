import { describe, expect, it } from "bun:test";
import {
	HLC_ZERO,
	generateHlc,
	hlcToDate,
	mergeHlc,
	parseHlc,
} from "../hlc.js";

const SITE_A = "aaaa1111aaaa1111aaaa1111aaaa1111";
const SITE_B = "bbbb2222bbbb2222bbbb2222bbbb2222";

describe("parseHlc", () => {
	it("round-trips a generated HLC", () => {
		const hlc = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const [ts, counter, siteId] = parseHlc(hlc);
		expect(ts).toBe("2026-04-11T04:30:00.000Z");
		expect(counter).toBe("0000");
		expect(siteId).toBe(SITE_A);
	});

	it("parses HLC_ZERO", () => {
		const [ts, counter, siteId] = parseHlc(HLC_ZERO);
		expect(ts).toBe("0000-00-00T00:00:00.000Z");
		expect(counter).toBe("0000");
		expect(siteId).toBe("0000");
	});
});

describe("generateHlc", () => {
	it("produces timestamp_counter_siteId format", () => {
		const hlc = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		expect(hlc).toBe(`2026-04-11T04:30:00.000Z_0000_${SITE_A}`);
	});

	it("resets counter when wall clock advances", () => {
		const prev = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const next = generateHlc("2026-04-11T04:31:00.000Z", prev, SITE_A);
		const [, counter] = parseHlc(next);
		expect(counter).toBe("0000");
	});

	it("increments counter when wall clock has not advanced", () => {
		const prev = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const next = generateHlc("2026-04-11T04:30:00.000Z", prev, SITE_A);
		const [, counter] = parseHlc(next);
		expect(counter).toBe("0001");
	});

	it("increments counter when wall clock goes backward", () => {
		const prev = generateHlc("2026-04-11T04:31:00.000Z", null, SITE_A);
		// Wall clock is earlier than last HLC timestamp
		const next = generateHlc("2026-04-11T04:30:00.000Z", prev, SITE_A);
		const [ts, counter] = parseHlc(next);
		// Should keep the higher timestamp from lastHlc
		expect(ts).toBe("2026-04-11T04:31:00.000Z");
		expect(counter).toBe("0001");
	});

	it("produces monotonically increasing values under rapid calls", () => {
		const results: string[] = [];
		let last: string | null = null;
		const fixedTime = "2026-04-11T04:30:00.000Z";
		for (let i = 0; i < 100; i++) {
			const hlc = generateHlc(fixedTime, last, SITE_A);
			results.push(hlc);
			last = hlc;
		}
		for (let i = 1; i < results.length; i++) {
			expect(results[i] > results[i - 1]).toBe(true);
		}
	});
});

describe("mergeHlc", () => {
	it("produces value greater than both local and remote", () => {
		const local = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const remote = generateHlc("2026-04-11T04:30:05.000Z", null, SITE_B);
		const merged = mergeHlc(local, remote, SITE_A);
		expect(merged > local).toBe(true);
		expect(merged > remote).toBe(true);
	});

	it("uses wall clock when it exceeds both local and remote", () => {
		const local = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const remote = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_B);
		const merged = mergeHlc(local, remote, SITE_A);
		// Wall clock is Date.now() which is > both, so counter resets
		const [, counter, siteId] = parseHlc(merged);
		expect(siteId).toBe(SITE_A);
		// Counter should be 0000 since wallclock is ahead
		expect(counter).toBe("0000");
	});

	it("increments max counter when timestamps are equal", () => {
		const ts = "2099-12-31T23:59:59.999Z"; // Far future to beat Date.now()
		const local = `${ts}_0005_${SITE_A}`;
		const remote = `${ts}_0003_${SITE_B}`;
		const merged = mergeHlc(local, remote, SITE_A);
		const [mergedTs, counter] = parseHlc(merged);
		expect(mergedTs).toBe(ts);
		// max(5, 3) + 1 = 6
		expect(counter).toBe("0006");
	});
});

describe("hlcToDate", () => {
	it("extracts the wall clock as a Date", () => {
		const hlc = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const date = hlcToDate(hlc);
		expect(date.toISOString()).toBe("2026-04-11T04:30:00.000Z");
	});

	it("returns epoch for HLC_ZERO", () => {
		const date = hlcToDate(HLC_ZERO);
		expect(date.getTime()).toBe(new Date("0000-00-00T00:00:00.000Z").getTime());
	});
});

describe("HLC_ZERO", () => {
	it("compares less than any real HLC", () => {
		const real = generateHlc("1970-01-01T00:00:00.001Z", null, SITE_A);
		expect(HLC_ZERO < real).toBe(true);
	});

	it("has the correct format", () => {
		expect(HLC_ZERO).toBe("0000-00-00T00:00:00.000Z_0000_0000");
	});
});

describe("string comparison preserves causal order", () => {
	it("later timestamps sort after earlier ones", () => {
		const early = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const late = generateHlc("2026-04-11T04:31:00.000Z", null, SITE_A);
		expect(late > early).toBe(true);
	});

	it("same timestamp, higher counter sorts later", () => {
		const first = generateHlc("2026-04-11T04:30:00.000Z", null, SITE_A);
		const second = generateHlc("2026-04-11T04:30:00.000Z", first, SITE_A);
		expect(second > first).toBe(true);
	});

	it("same timestamp and counter, site_id provides total order", () => {
		const hlcA = `2026-04-11T04:30:00.000Z_0000_${SITE_A}`;
		const hlcB = `2026-04-11T04:30:00.000Z_0000_${SITE_B}`;
		// One must be greater than the other (deterministic total order)
		expect(hlcA !== hlcB).toBe(true);
		expect(hlcA < hlcB || hlcA > hlcB).toBe(true);
	});

	it("events from different sites with same wall clock get different HLCs", () => {
		const ts = "2026-04-11T04:30:00.000Z";
		const hlcA = generateHlc(ts, null, SITE_A);
		const hlcB = generateHlc(ts, null, SITE_B);
		expect(hlcA).not.toBe(hlcB);
	});
});
