import { describe, expect, it } from "bun:test";
import { lineRoute, parseLineRoute } from "../route-utils";

describe("route-utils", () => {
	describe("lineRoute", () => {
		it("builds a /line/:threadId route", () => {
			expect(lineRoute("abc-123")).toBe("/line/abc-123");
		});
	});

	describe("parseLineRoute", () => {
		it("extracts threadId from a simple route", () => {
			expect(parseLineRoute("/line/abc-123")).toEqual({ threadId: "abc-123" });
		});

		it("extracts threadId and from query param", () => {
			expect(parseLineRoute("/line/abc-123?from=/timetable")).toEqual({
				threadId: "abc-123",
				from: "/timetable",
			});
		});

		it("returns empty threadId for malformed route", () => {
			expect(parseLineRoute("/")).toEqual({ threadId: "" });
		});
	});
});
