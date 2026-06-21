import { describe, expect, it } from "bun:test";
import { lineRoute, parseLineRoute, parseTaskRoute, taskRoute } from "../route-utils";

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

	describe("taskRoute", () => {
		it("builds a /task/:taskId route", () => {
			expect(taskRoute("def-456")).toBe("/task/def-456");
		});
	});

	describe("parseTaskRoute", () => {
		it("extracts taskId from a simple route", () => {
			expect(parseTaskRoute("/task/def-456")).toEqual({ taskId: "def-456" });
		});

		it("strips query params", () => {
			expect(parseTaskRoute("/task/def-456?from=/timetable")).toEqual({ taskId: "def-456" });
		});

		it("returns empty taskId for malformed route", () => {
			expect(parseTaskRoute("/timetable")).toEqual({ taskId: "" });
		});
	});
});
