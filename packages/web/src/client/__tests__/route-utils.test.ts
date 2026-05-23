import { describe, expect, it } from "bun:test";
import { lineRoute, parseLineRoute } from "../lib/route-utils";

describe("lineRoute", () => {
	it("returns the correct route for a thread id", () => {
		expect(lineRoute("abc123")).toBe("/line/abc123");
		expect(lineRoute("uuid-with-dashes-1234")).toBe("/line/uuid-with-dashes-1234");
	});

	it("is the inverse of parseLineRoute", () => {
		const id = "test-thread-id";
		expect(parseLineRoute(lineRoute(id)).threadId).toBe(id);
	});
});

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
