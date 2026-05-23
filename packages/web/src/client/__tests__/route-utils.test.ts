import { describe, expect, it } from "bun:test";
import { parseLineRoute } from "../lib/route-utils";

describe("parseLineRoute", () => {
	it("extracts threadId from route without from param", () => {
		expect(parseLineRoute("/line/abc123")).toEqual({ threadId: "abc123", from: undefined });
	});

	it("extracts threadId and from param when present", () => {
		expect(parseLineRoute("/line/abc123?from=/timetable")).toEqual({
			threadId: "abc123",
			from: "/timetable",
		});
	});

	it("handles empty from param gracefully", () => {
		const result = parseLineRoute("/line/abc123?from=");
		expect(result.threadId).toBe("abc123");
		expect(result.from).toBeUndefined();
	});
});
