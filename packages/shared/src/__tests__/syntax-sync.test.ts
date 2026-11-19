import { describe, expect, it } from "bun:test";
import { getHighlighterSync, prewarmHighlighter } from "../syntax";

describe("getHighlighterSync", () => {
	it("returns the warmed singleton after prewarmHighlighter resolves", async () => {
		await prewarmHighlighter();
		const h = getHighlighterSync();
		expect(h).not.toBeNull();
		// A real highlighter can tokenize — exercise it to prove it is live.
		const tokens = h?.codeToTokens("const x = 1;", {
			lang: "typescript",
			theme: "tokyo-night",
		});
		expect(tokens?.tokens.length).toBeGreaterThan(0);
	});
});
