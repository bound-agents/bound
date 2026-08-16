import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { sortRows } from "../data-table-utils";

type Row = { id: number; value?: string | number | null };

const textValueArb = fc.string({ maxLength: 20 });
const valueArb = fc.option(fc.oneof(textValueArb, fc.integer()), { nil: undefined });

function compareValues(a: string | number, b: string | number): number {
	if (typeof a === "string" && typeof b === "string") {
		return a.localeCompare(b, undefined, { sensitivity: "base" });
	}
	if (typeof a === "number" && typeof b === "number") return a - b;
	return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

describe("sortRows", () => {
	it("sorts a representative mixed table case", () => {
		const rows = [
			{ id: "1", name: "Zebra" },
			{ id: "2", name: "apple" },
			{ id: "3", name: null },
			{ id: "4", name: "BANANA" },
		];

		expect(sortRows(rows, "name", "asc")).toEqual([
			{ id: "2", name: "apple" },
			{ id: "4", name: "BANANA" },
			{ id: "1", name: "Zebra" },
			{ id: "3", name: null },
		]);
	});

	it("preserves the input and returns a permutation with defined values ordered before nullish values", () => {
		fc.assert(
			fc.property(
				fc.array(valueArb, { maxLength: 50 }),
				fc.constantFrom("asc", "desc"),
				(values, dir) => {
					const rows: Row[] = values.map((value, id) =>
						value === undefined ? { id } : { id, value },
					);
					const original = structuredClone(rows);
					const sorted = sortRows(rows, "value", dir) as Row[];
					if (sorted === rows || JSON.stringify(rows) !== JSON.stringify(original)) return false;
					if (sorted.length !== rows.length) return false;
					if (new Set(sorted.map((row) => row.id)).size !== sorted.length) return false;
					if (!rows.every((row) => sorted.includes(row))) return false;

					const firstNullish = sorted.findIndex(
						(row) => row.value === null || row.value === undefined,
					);
					if (
						firstNullish !== -1 &&
						sorted.slice(firstNullish).some((row) => row.value !== null && row.value !== undefined)
					)
						return false;

					const defined = sorted.filter(
						(row): row is Row & { value: string | number } =>
							row.value !== null && row.value !== undefined,
					);
					return defined.every((row, index) => {
						if (index === 0) return true;
						const comparison = compareValues(defined[index - 1].value, row.value);
						return dir === "asc" ? comparison <= 0 : comparison >= 0;
					});
				},
			),
			{ numRuns: 200 },
		);
	});

	it("keeps equal and nullish values stable", () => {
		fc.assert(
			fc.property(
				fc.array(fc.option(textValueArb, { nil: null }), { maxLength: 50 }),
				fc.constantFrom("asc", "desc"),
				(values, dir) => {
					const rows = values.map((value, id) => ({ id, value }));
					const sorted = sortRows(rows, "value", dir) as Array<{
						id: number;
						value: string | null;
					}>;
					for (let i = 0; i < sorted.length; i++) {
						for (let j = i + 1; j < sorted.length; j++) {
							if (sorted[i].value === sorted[j].value && sorted[i].id > sorted[j].id) return false;
						}
					}
					return true;
				},
			),
			{ numRuns: 200 },
		);
	});

	it("returns a copied, unchanged sequence when sorting is disabled", () => {
		fc.assert(
			fc.property(
				fc.array(valueArb, { maxLength: 50 }),
				fc.constantFrom(null, undefined),
				(values, key) => {
					const rows: Row[] = values.map((value, id) =>
						value === undefined ? { id } : { id, value },
					);
					const result = sortRows(rows, key, "asc");
					return result !== rows && JSON.stringify(result) === JSON.stringify(rows);
				},
			),
			{ numRuns: 100 },
		);
	});
});
