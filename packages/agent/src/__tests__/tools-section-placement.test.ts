/**
 * #97 — Place the tool-definition chunk in the correct cached region of the
 * context-debug visualization.
 *
 * Tool definitions ride in the cacheable prefix on the wire (Anthropic/Bedrock
 * order: tools → system → messages), so a system-level cache breakpoint caches
 * them. The debugger previously rendered the `tools` section at the far right,
 * after BOTH cachePoints, implying tools were uncached. `placeToolsAfterSystem`
 * moves the section to sit immediately after `system`, inside the cached
 * region. The complementary offset fix lives in `buildCacheMarkers`
 * (tool tokens fold into the system-prefix offset) — see cache-marker-gating.
 */

import { describe, expect, it } from "bun:test";
import type { ContextSection } from "@bound/shared";
import { placeToolsAfterSystem } from "../context-assembly";

describe("placeToolsAfterSystem (#97)", () => {
	it("moves the tools section to immediately after system", () => {
		const sections: ContextSection[] = [
			{ name: "system", tokens: 5000 },
			{ name: "skill-context", tokens: 1500 },
			{ name: "volatile-prefix", tokens: 3500 },
			{ name: "history", tokens: 80000 },
			{ name: "volatile-tail", tokens: 4000 },
			{ name: "tools", tokens: 2000 },
		];
		placeToolsAfterSystem(sections);
		expect(sections.map((s) => s.name)).toEqual([
			"system",
			"tools",
			"skill-context",
			"volatile-prefix",
			"history",
			"volatile-tail",
		]);
	});

	it("renders tools left of the history boundary so it falls inside the cached region", () => {
		// The cached region is everything up to (and including) the system
		// cachePoint, which sits at the end of the stable prefix — i.e. just
		// before `history`. After reordering, `tools` must precede `history`.
		const sections: ContextSection[] = [
			{ name: "system", tokens: 5000 },
			{ name: "history", tokens: 80000 },
			{ name: "tools", tokens: 2000 },
		];
		placeToolsAfterSystem(sections);
		const toolsIdx = sections.findIndex((s) => s.name === "tools");
		const historyIdx = sections.findIndex((s) => s.name === "history");
		expect(toolsIdx).toBeLessThan(historyIdx);
		expect(toolsIdx).toBe(1);
	});

	it("is a no-op when there is no tools section", () => {
		const sections: ContextSection[] = [
			{ name: "system", tokens: 5000 },
			{ name: "history", tokens: 80000 },
		];
		placeToolsAfterSystem(sections);
		expect(sections.map((s) => s.name)).toEqual(["system", "history"]);
	});

	it("inserts at the front when there is no system section", () => {
		const sections: ContextSection[] = [
			{ name: "history", tokens: 80000 },
			{ name: "tools", tokens: 2000 },
		];
		placeToolsAfterSystem(sections);
		expect(sections.map((s) => s.name)).toEqual(["tools", "history"]);
	});

	it("preserves the total token sum (reorder only, no mutation of values)", () => {
		const sections: ContextSection[] = [
			{ name: "system", tokens: 5000 },
			{ name: "skill-context", tokens: 1500 },
			{ name: "history", tokens: 80000 },
			{ name: "tools", tokens: 2000 },
		];
		const before = sections.reduce((s, sec) => s + sec.tokens, 0);
		placeToolsAfterSystem(sections);
		const after = sections.reduce((s, sec) => s + sec.tokens, 0);
		expect(after).toBe(before);
	});
});
