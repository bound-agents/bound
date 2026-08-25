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
	it("unwraps a Yard result envelope before sanitizing, displaying, and classifying its return value", () => {
		const formatted = formatYardResult('{"result":{"nested":[1,2],"redacted_data":"secret"}}');

		expect(formatted).toEqual({
			display: '{\n  "nested": [\n    1,\n    2\n  ]\n}',
			hint: "object · 1 key · 52 B",
			isJson: true,
		});
	});

	it("reports object keys, array items, and raw byte size", () => {
		expect(formatYardResult('{"alpha":1,"beta":2}')).toMatchObject({
			hint: "object · 2 keys · 20 B",
			isJson: true,
		});
		expect(formatYardResult('["a","b","c"]')).toMatchObject({
			hint: "array · 3 items · 13 B",
			isJson: true,
		});
	});

	it("unwraps a persisted tool-result envelope and pretty-prints the same JSON value it classifies", () => {
		const raw = JSON.stringify({ result: { listing: "first\nsecond", status: "ok" } });

		expect(formatYardResult(raw)).toEqual({
			display: '{\n  "listing": "first\\nsecond",\n  "status": "ok"\n}',
			hint: `object · 2 keys · ${new TextEncoder().encode(raw).byteLength} B`,
			isJson: true,
		});
	});

	it("unwraps text blocks before parsing the contained persisted result", () => {
		const raw = JSON.stringify([
			{ type: "text", text: '{"result":{"listing":"first\\nsecond","status":"ok"}}' },
		]);

		expect(formatYardResult(raw)).toMatchObject({
			display: '{\n  "listing": "first\\nsecond",\n  "status": "ok"\n}',
			hint: `object · 2 keys · ${new TextEncoder().encode(raw).byteLength} B`,
			isJson: true,
		});
	});

	it("keeps genuinely unparseable result text readable", () => {
		expect(formatYardResult("not valid {json")).toEqual({
			display: "not valid {json",
			hint: "plain text · 15 B",
			isJson: false,
		});
	});
});
