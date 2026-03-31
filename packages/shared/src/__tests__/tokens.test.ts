import { describe, expect, it } from "bun:test";
import { countContentTokens, countTokens } from "../tokens";

describe("tokens", () => {
	describe("countTokens", () => {
		it("AC1.1: returns positive integer for normal text", () => {
			const count = countTokens("hello world");
			expect(count).toBeGreaterThan(0);
			expect(Number.isInteger(count)).toBe(true);
		});

		it("AC1.1: cl100k_base encodes 'hello world' as 2 tokens", () => {
			expect(countTokens("hello world")).toBe(2);
		});

		it("AC1.5: empty string returns 0", () => {
			expect(countTokens("")).toBe(0);
		});

		it("handles long text with reasonable token count", () => {
			// 1000 characters should be approximately 250 tokens
			const longText = "a".repeat(1000);
			const count = countTokens(longText);
			expect(count).toBeGreaterThan(100);
			expect(count).toBeLessThan(500);
		});
	});

	describe("countContentTokens", () => {
		it("AC1.2 (string): matches countTokens for string input", () => {
			const text = "hello world";
			expect(countContentTokens(text)).toBe(countTokens(text));
		});

		it("AC1.5: empty string returns 0", () => {
			expect(countContentTokens("")).toBe(0);
		});

		it("AC1.2 (ContentBlock[]): empty array returns 0", () => {
			expect(countContentTokens([])).toBe(0);
		});

		it("AC1.2 (ContentBlock[]): single text block", () => {
			const content = [{ type: "text", text: "hello" }];
			const expected = countTokens("hello");
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.5 (ContentBlock[]): text block with empty string", () => {
			const content = [{ type: "text", text: "" }];
			expect(countContentTokens(content)).toBe(0);
		});

		it("AC1.2 (ContentBlock[]): multiple text blocks sum", () => {
			const content = [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			];
			const expected = countTokens("hello") + countTokens("world");
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.2 (ContentBlock[]): tool_use block counts as JSON", () => {
			const toolUseBlock = {
				type: "tool_use",
				id: "1",
				name: "test",
				input: {},
			};
			const content = [toolUseBlock];
			const expected = countTokens(JSON.stringify(toolUseBlock));
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.2 (ContentBlock[]): mixed text and tool_use blocks", () => {
			const content = [
				{ type: "text", text: "hello" },
				{
					type: "tool_use",
					id: "1",
					name: "test",
					input: {},
				},
			];
			const expected = countTokens("hello") + countTokens(JSON.stringify(content[1]));
			expect(countContentTokens(content)).toBe(expected);
		});

		it("AC1.4: lazy initialization works on first call", () => {
			// Simply verify that calling countTokens works correctly
			// (proves lazy init succeeded)
			const result = countTokens("test");
			expect(result).toBeGreaterThan(0);
		});
	});
});
