import { describe, expect, it } from "bun:test";
import { MAX_THREAD_TITLE_LENGTH, resolveTitleEdit } from "../../lib/thread-title";

describe("resolveTitleEdit", () => {
	it("returns the trimmed draft when it changes the title", () => {
		expect(resolveTitleEdit("  New name ", "Old name")).toBe("New name");
		expect(resolveTitleEdit("First", null)).toBe("First");
	});

	it("returns null for blank, unchanged, or over-limit drafts", () => {
		expect(resolveTitleEdit("   ", "Old")).toBeNull();
		expect(resolveTitleEdit(" Old ", "Old ")).toBeNull();
		expect(resolveTitleEdit("x".repeat(MAX_THREAD_TITLE_LENGTH + 1), "Old")).toBeNull();
		expect(resolveTitleEdit("x".repeat(MAX_THREAD_TITLE_LENGTH), "Old")).toHaveLength(
			MAX_THREAD_TITLE_LENGTH,
		);
	});
});
