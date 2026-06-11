import { describe, expect, it } from "bun:test";
import { formatBucketAxisLabel, formatBucketTooltipLabel, parseBucket } from "../chart-time";

describe("parseBucket", () => {
	it("parses a daily bucket as a UTC calendar date", () => {
		const p = parseBucket("2026-06-10");
		expect(p.daily).toBe(true);
		expect(p.dateObj.toISOString()).toBe("2026-06-10T00:00:00.000Z");
	});

	it("parses a zoned hourly bucket as the given UTC instant", () => {
		const p = parseBucket("2026-06-10T14:00:00Z");
		expect(p.daily).toBe(false);
		expect(p.dateObj.toISOString()).toBe("2026-06-10T14:00:00.000Z");
	});

	it("treats a legacy zoneless hourly bucket as UTC, not local time", () => {
		const p = parseBucket("2026-06-10T14:00");
		expect(p.daily).toBe(false);
		expect(p.dateObj.toISOString()).toBe("2026-06-10T14:00:00.000Z");
	});

	it("respects an explicit non-UTC offset", () => {
		const p = parseBucket("2026-06-10T14:00:00+02:00");
		expect(p.dateObj.toISOString()).toBe("2026-06-10T12:00:00.000Z");
	});
});

describe("formatBucketAxisLabel", () => {
	it("labels a daily bucket from the raw string, immune to viewer timezone", () => {
		// new Date("2026-06-10") is UTC midnight; in any tz west of UTC the
		// local getDate() would say 6/9. The label must come from the string.
		expect(formatBucketAxisLabel(parseBucket("2026-06-10"))).toBe("6/10");
		expect(formatBucketAxisLabel(parseBucket("2026-01-02"))).toBe("1/2");
	});

	it("labels an hourly bucket with the local hour", () => {
		const p = parseBucket("2026-06-10T14:00:00Z");
		const localHour = p.dateObj.getHours();
		const expected =
			localHour === 0
				? `${p.dateObj.getMonth() + 1}/${p.dateObj.getDate()}`
				: `${String(localHour).padStart(2, "0")}:00`;
		expect(formatBucketAxisLabel(p)).toBe(expected);
	});
});

describe("formatBucketTooltipLabel", () => {
	it("renders a daily bucket as its raw calendar date", () => {
		expect(formatBucketTooltipLabel(parseBucket("2026-06-10"))).toBe("2026-06-10");
	});

	it("renders an hourly bucket as local date-time", () => {
		const p = parseBucket("2026-06-10T14:00:00Z");
		const d = p.dateObj;
		const pad = (n: number) => String(n).padStart(2, "0");
		expect(formatBucketTooltipLabel(p)).toBe(
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
		);
	});
});
