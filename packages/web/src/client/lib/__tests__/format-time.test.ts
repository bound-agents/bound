import { describe, expect, it } from "bun:test";
import { fmtHhmm, formatBytes, formatDate, isToday } from "../format-time";

describe("format-time", () => {
	it("isToday compares local calendar days", () => {
		const now = new Date();
		const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 1);
		expect(isToday(localMidnight.toISOString())).toBe(true);
		const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59);
		expect(isToday(yesterday.toISOString())).toBe(false);
	});

	it("formatDate renders month/day/year and falls back to the empty option", () => {
		expect(formatDate("2026-02-13T12:00:00Z")).toBe("Feb 13, 2026");
		expect(formatDate("not a date")).toBe("not a date");
		expect(formatDate("not a date", { empty: "—" })).toBe("—");
	});

	it("fmtHhmm renders 24-hour local time and the empty option for missing input", () => {
		const iso = new Date(2026, 0, 1, 14, 5).toISOString();
		expect(fmtHhmm(iso)).toBe("14:05");
		expect(fmtHhmm(undefined)).toBe("");
		expect(fmtHhmm("garbage", { empty: "—" })).toBe("—");
	});

	it("formatBytes scales by 1024", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
	});
});
