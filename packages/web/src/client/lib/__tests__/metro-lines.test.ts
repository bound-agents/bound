import { describe, expect, it } from "bun:test";
import { getLineCode, getLineColor, getLineCssVar, getLineName } from "../metro-lines";

describe("getLineColor", () => {
	it("returns valid distinct hex color for indices 0-9", () => {
		const colors = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const color = getLineColor(i);
			// Verify it's a valid hex color
			expect(color).toMatch(/^#[0-9A-F]{6}$/i);
			colors.add(color);
		}
		// Verify all 10 colors are distinct
		expect(colors.size).toBe(10);
	});

	it("wraps around for indices >= 10 (modulo behavior)", () => {
		// Index 10 should wrap to index 0 (Ginza line)
		expect(getLineColor(10)).toBe(getLineColor(0));
		// Index 11 should wrap to index 1 (Marunouchi line)
		expect(getLineColor(11)).toBe(getLineColor(1));
		// Index 20 should wrap to index 0
		expect(getLineColor(20)).toBe(getLineColor(0));
		// Index 25 should wrap to index 5 (Yurakucho line)
		expect(getLineColor(25)).toBe(getLineColor(5));
	});
});

describe("getLineCode", () => {
	it("returns correct single-letter codes", () => {
		const expectedCodes = ["G", "M", "H", "T", "C", "Y", "Z", "N", "F", "E"];
		for (let i = 0; i < 10; i++) {
			expect(getLineCode(i)).toBe(expectedCodes[i]);
		}
	});

	it("wraps around for indices >= 10 (modulo behavior)", () => {
		// Index 10 should wrap to index 0 (Ginza = G)
		expect(getLineCode(10)).toBe(getLineCode(0));
		// Index 11 should wrap to index 1 (Marunouchi = M)
		expect(getLineCode(11)).toBe(getLineCode(1));
		// Index 20 should wrap to index 0 (Ginza = G)
		expect(getLineCode(20)).toBe(getLineCode(0));
	});
});

describe("getLineName", () => {
	it("returns the canonical station-line name for indices 0-9", () => {
		const expected = [
			"Ginza",
			"Marunouchi",
			"Hibiya",
			"Tozai",
			"Chiyoda",
			"Yurakucho",
			"Hanzomon",
			"Namboku",
			"Fukutoshin",
			"Oedo",
		];
		for (let i = 0; i < 10; i++) {
			expect(getLineName(i)).toBe(expected[i]);
		}
	});

	it("wraps around for indices >= 10", () => {
		expect(getLineName(10)).toBe("Ginza");
		expect(getLineName(13)).toBe("Tozai");
	});
});

describe("getLineCssVar", () => {
	it("renders the per-line CSS custom-property reference", () => {
		expect(getLineCssVar(0)).toBe("var(--line-0)");
		expect(getLineCssVar(9)).toBe("var(--line-9)");
	});

	it("wraps the index into the 0-9 range", () => {
		expect(getLineCssVar(10)).toBe("var(--line-0)");
		expect(getLineCssVar(15)).toBe("var(--line-5)");
	});
});
