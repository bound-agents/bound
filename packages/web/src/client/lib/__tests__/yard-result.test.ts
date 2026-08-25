import { describe, expect, it } from "bun:test";
import { formatYardResult, sanitizeYardResult } from "../yard-result";

describe("sanitizeYardResult", () => {
	it("recursively omits encrypted reasoning and signature fields without changing ordinary values", () => {
		const value = {
			answer: "kept",
			reasoning_encrypted_content: "secret",
			nested: [
				{ redacted_data: "hidden", value: 42 },
				{ signature: "sig", ok: true },
			],
			signatures: ["also-hidden"],
		};

		expect(sanitizeYardResult(value)).toEqual({
			answer: "kept",
			nested: [{ value: 42 }, { ok: true }],
		});
		expect(value.reasoning_encrypted_content).toBe("secret");
	});

	it("removes empty encrypted thinking blocks from arrays", () => {
		expect(
			sanitizeYardResult([
				{ type: "thinking", thinking: "", reasoning_encrypted_content: "secret" },
				{ type: "text", text: "ordinary output" },
			]),
		).toEqual([{ type: "text", text: "ordinary output" }]);
	});
});

describe("formatYardResult", () => {
	it("pretty-prints sanitized JSON with an informative type and size hint", () => {
		const formatted = formatYardResult('{"result":{"nested":[1,2],"redacted_data":"secret"}}');

		expect(formatted).toEqual({
			display: '{\n  "result": {\n    "nested": [\n      1,\n      2\n    ]\n  }\n}',
			hint: "JSON object · 52 B",
			isJson: true,
		});
	});

	it("keeps malformed and non-JSON result text readable", () => {
		expect(formatYardResult("not valid {json")).toEqual({
			display: "not valid {json",
			hint: "plain text · 15 B",
			isJson: false,
		});
	});
});
