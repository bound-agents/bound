import { describe, expect, it } from "bun:test";
import { sortRows } from "../data-table-utils";

describe("sortRows", () => {
	describe("string sorting", () => {
		it("sorts strings ascending", () => {
			const rows = [
				{ id: "1", name: "zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
			];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
				{ id: "1", name: "zebra" },
			]);
		});

		it("sorts strings descending", () => {
			const rows = [
				{ id: "1", name: "zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
			];

			const result = sortRows(rows, "name", "desc");

			expect(result).toEqual([
				{ id: "1", name: "zebra" },
				{ id: "3", name: "banana" },
				{ id: "2", name: "apple" },
			]);
		});

		it("sorts strings case-insensitively", () => {
			const rows = [
				{ id: "1", name: "Zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "BANANA" },
			];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([
				{ id: "2", name: "apple" },
				{ id: "3", name: "BANANA" },
				{ id: "1", name: "Zebra" },
			]);
		});
	});

	describe("number sorting", () => {
		it("sorts numbers ascending", () => {
			const rows = [
				{ id: "1", count: 100 },
				{ id: "2", count: 5 },
				{ id: "3", count: 50 },
			];

			const result = sortRows(rows, "count", "asc");

			expect(result).toEqual([
				{ id: "2", count: 5 },
				{ id: "3", count: 50 },
				{ id: "1", count: 100 },
			]);
		});

		it("sorts numbers descending", () => {
			const rows = [
				{ id: "1", count: 100 },
				{ id: "2", count: 5 },
				{ id: "3", count: 50 },
			];

			const result = sortRows(rows, "count", "desc");

			expect(result).toEqual([
				{ id: "1", count: 100 },
				{ id: "3", count: 50 },
				{ id: "2", count: 5 },
			]);
		});

		it("sorts negative numbers correctly", () => {
			const rows = [
				{ id: "1", value: 10 },
				{ id: "2", value: -5 },
				{ id: "3", value: 0 },
			];

			const result = sortRows(rows, "value", "asc");

			expect(result).toEqual([
				{ id: "2", value: -5 },
				{ id: "3", value: 0 },
				{ id: "1", value: 10 },
			]);
		});
	});

	describe("null values", () => {
		it("sorts null values to end in ascending order", () => {
			const rows = [
				{ id: "1", name: "alice" },
				{ id: "2", name: null },
				{ id: "3", name: "bob" },
			];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([
				{ id: "1", name: "alice" },
				{ id: "3", name: "bob" },
				{ id: "2", name: null },
			]);
		});

		it("sorts null values to end in descending order", () => {
			const rows = [
				{ id: "1", name: "alice" },
				{ id: "2", name: null },
				{ id: "3", name: "bob" },
			];

			const result = sortRows(rows, "name", "desc");

			expect(result).toEqual([
				{ id: "3", name: "bob" },
				{ id: "1", name: "alice" },
				{ id: "2", name: null },
			]);
		});

		it("keeps multiple nulls at end preserving original order", () => {
			const rows = [
				{ id: "1", name: null },
				{ id: "2", name: "alice" },
				{ id: "3", name: null },
			];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([
				{ id: "2", name: "alice" },
				{ id: "1", name: null },
				{ id: "3", name: null },
			]);
		});
	});

	describe("no sort key", () => {
		it("returns original order when sortKey is null", () => {
			const rows = [
				{ id: "1", name: "zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
			];

			const result = sortRows(rows, null, "asc");

			expect(result).toEqual([
				{ id: "1", name: "zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
			]);
		});

		it("returns original order when sortKey is undefined", () => {
			const rows = [
				{ id: "1", count: 100 },
				{ id: "2", count: 5 },
				{ id: "3", count: 50 },
			];

			const result = sortRows(rows, undefined, "asc");

			expect(result).toEqual([
				{ id: "1", count: 100 },
				{ id: "2", count: 5 },
				{ id: "3", count: 50 },
			]);
		});
	});

	describe("immutability", () => {
		it("does not mutate input array", () => {
			const rows = [
				{ id: "1", name: "zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
			];
			const original = [...rows];

			sortRows(rows, "name", "asc");

			expect(rows).toEqual(original);
		});

		it("returns a new array", () => {
			const rows = [
				{ id: "1", name: "zebra" },
				{ id: "2", name: "apple" },
				{ id: "3", name: "banana" },
			];

			const result = sortRows(rows, "name", "asc");

			expect(result).not.toBe(rows);
		});
	});

	describe("edge cases", () => {
		it("handles empty array", () => {
			const rows: Record<string, unknown>[] = [];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([]);
		});

		it("handles single row", () => {
			const rows = [{ id: "1", name: "alice" }];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([{ id: "1", name: "alice" }]);
		});

		it("handles rows with missing sort key property", () => {
			const rows = [{ id: "1", name: "alice" }, { id: "2" }, { id: "3", name: "bob" }];

			const result = sortRows(rows, "name", "asc");

			expect(result).toEqual([{ id: "1", name: "alice" }, { id: "3", name: "bob" }, { id: "2" }]);
		});

		it("maintains stable sort for equal values", () => {
			const rows = [
				{ id: "1", priority: 1 },
				{ id: "2", priority: 2 },
				{ id: "3", priority: 1 },
				{ id: "4", priority: 2 },
			];

			const result = sortRows(rows, "priority", "asc");

			expect(result).toEqual([
				{ id: "1", priority: 1 },
				{ id: "3", priority: 1 },
				{ id: "2", priority: 2 },
				{ id: "4", priority: 2 },
			]);
		});
	});
});
