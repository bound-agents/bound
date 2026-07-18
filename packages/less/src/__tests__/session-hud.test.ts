import { describe, expect, it } from "bun:test";
import { contextGaugeColor } from "../tui/components/StatusBar";
import { formatTokens, formatUsd } from "../tui/hooks/useSessionHud";

describe("session HUD formatters", () => {
	it("formatUsd: cents precision under $100, whole dollars to $999, k above", () => {
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(0.42)).toBe("$0.42");
		expect(formatUsd(12.345)).toBe("$12.35");
		expect(formatUsd(123.4)).toBe("$123");
		expect(formatUsd(1234)).toBe("$1.2k");
	});

	it("formatTokens: raw to 999, one decimal to 9.9k, whole k to 999k, M above", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(87_000)).toBe("87k");
		expect(formatTokens(1_100_000)).toBe("1.1M");
	});

	it("contextGaugeColor: green under 60%, yellow to 85%, red above", () => {
		expect(contextGaugeColor(0.2)).toBe("green");
		expect(contextGaugeColor(0.59)).toBe("green");
		expect(contextGaugeColor(0.6)).toBe("yellow");
		expect(contextGaugeColor(0.84)).toBe("yellow");
		expect(contextGaugeColor(0.85)).toBe("red");
		expect(contextGaugeColor(1)).toBe("red");
	});
});
