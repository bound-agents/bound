import { describe, expect, it } from "bun:test";
import { type StyledRun, wrapStyledRuns } from "../wrap-styled";

/** Concatenate a visual line's runs back into its plain string. */
const lineText = (line: StyledRun[]): string => line.map((r) => r.text).join("");

describe("wrapStyledRuns", () => {
	it("returns a single line when text fits within width", () => {
		const runs: StyledRun[] = [{ text: "short line" }];
		const lines = wrapStyledRuns(runs, 40);
		expect(lines.length).toBe(1);
		expect(lineText(lines[0])).toBe("short line");
	});

	it("elides leading whitespace on continuation lines (issue #130)", () => {
		// "the quick brown fox jumps over the lazy dog" at width 10 wraps such
		// that continuation lines would otherwise begin with the inter-word
		// space (e.g. " the lazy ").
		const runs: StyledRun[] = [{ text: "the quick brown fox jumps over the lazy dog" }];
		const lines = wrapStyledRuns(runs, 10);
		expect(lines.length).toBeGreaterThan(1);
		// First line keeps its content as-is.
		expect(lineText(lines[0])).toBe("the quick ");
		// No continuation line begins with whitespace.
		for (let i = 1; i < lines.length; i++) {
			expect(lineText(lines[i])).not.toMatch(/^\s/);
		}
	});

	it("preserves leading whitespace on the FIRST line (intentional indent)", () => {
		const runs: StyledRun[] = [{ text: "    indented start that is long enough to wrap here" }];
		const lines = wrapStyledRuns(runs, 12);
		expect(lineText(lines[0]).startsWith("    ")).toBe(true);
	});

	it("preserves run styling across the wrap boundary", () => {
		// A bold span that straddles a wrap point must stay bold on both lines.
		const runs: StyledRun[] = [
			{ text: "start " },
			{ text: "very bold spanning text here", bold: true },
			{ text: " end" },
		];
		const lines = wrapStyledRuns(runs, 10);
		// Every run whose text came from the bold span must carry bold=true.
		const boldText = lines
			.flat()
			.filter((r) => r.bold)
			.map((r) => r.text)
			.join("");
		// Leading whitespace elision may drop a boundary space, but the visible
		// bold words must all survive and stay bold.
		expect(boldText.replace(/\s/g, "")).toBe("veryboldspanningtexthere");
	});

	it("hard-breaks a single word longer than the width", () => {
		const runs: StyledRun[] = [{ text: "supercalifragilisticexpialidocious" }];
		const lines = wrapStyledRuns(runs, 10);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect([...lineText(line)].length).toBeLessThanOrEqual(10);
		}
		// No characters lost across the hard break.
		expect(lines.map(lineText).join("")).toBe("supercalifragilisticexpialidocious");
	});

	it("returns the runs unwrapped when width <= 0", () => {
		const runs: StyledRun[] = [{ text: "anything at all" }];
		const lines = wrapStyledRuns(runs, 0);
		expect(lines.length).toBe(1);
		expect(lineText(lines[0])).toBe("anything at all");
	});

	it("returns one empty line for empty input", () => {
		expect(wrapStyledRuns([], 20)).toEqual([[]]);
		expect(wrapStyledRuns([{ text: "" }], 20)).toEqual([[]]);
	});

	it("keeps distinct styles in separate runs within a line", () => {
		const runs: StyledRun[] = [
			{ text: "plain " },
			{ text: "code", color: "yellow" },
			{ text: " tail" },
		];
		const lines = wrapStyledRuns(runs, 40);
		expect(lines.length).toBe(1);
		const yellow = lines[0].filter((r) => r.color === "yellow");
		expect(yellow.length).toBe(1);
		expect(yellow[0].text).toBe("code");
	});
});
