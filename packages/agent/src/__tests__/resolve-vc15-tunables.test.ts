import { describe, expect, test } from "bun:test";
import { VC15_DEFAULT_M, VC15_DEFAULT_N, resolveVc15Tunables } from "../summary-extraction";

describe("resolveVc15Tunables", () => {
	test("1: Empty env returns defaults", () => {
		const result = resolveVc15Tunables({});
		expect(result).toEqual({ n: VC15_DEFAULT_N, m: VC15_DEFAULT_M });
		expect(result).toEqual({ n: 1000, m: 20 });
	});

	test("2: BOUND_VC15_N=300 sets n, default m", () => {
		const result = resolveVc15Tunables({ BOUND_VC15_N: "300" });
		expect(result).toEqual({ n: 300, m: VC15_DEFAULT_M });
		expect(result.m).toBe(20);
	});

	test("3: BOUND_VC15_M=5 sets m, default n", () => {
		const result = resolveVc15Tunables({ BOUND_VC15_M: "5" });
		expect(result).toEqual({ n: VC15_DEFAULT_N, m: 5 });
		expect(result.n).toBe(1000);
	});

	test("4: Non-numeric value falls back to default with no throw", () => {
		const result = resolveVc15Tunables({ BOUND_VC15_N: "not-a-number" });
		expect(result.n).toBe(VC15_DEFAULT_N);
		expect(result.m).toBe(VC15_DEFAULT_M);
	});

	test("5: Zero or negative values fall back to default", () => {
		const resultZero = resolveVc15Tunables({ BOUND_VC15_N: "0" });
		expect(resultZero.n).toBe(VC15_DEFAULT_N);

		const resultNegative = resolveVc15Tunables({ BOUND_VC15_M: "-10" });
		expect(resultNegative.m).toBe(VC15_DEFAULT_M);
	});
});
