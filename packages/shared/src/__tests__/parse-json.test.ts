import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { parseJsonSafe, parseJsonUntyped } from "../parse-json";

const schema = z.object({ name: z.string(), count: z.number() });

describe("parseJsonSafe", () => {
	it("returns the typed value for valid JSON matching the schema", () => {
		const result = parseJsonSafe(schema, '{"name":"polaris","count":3}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ name: "polaris", count: 3 });
		}
	});

	it("reports a JSON parse failure with the context label", () => {
		const result = parseJsonSafe(schema, "{not json", "tool_call");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("JSON parse failed (tool_call)");
		}
	});

	it("omits the parenthetical when no context is given", () => {
		const result = parseJsonSafe(schema, "{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toStartWith("JSON parse failed:");
			expect(result.error).not.toContain("(");
		}
	});

	it("reports a validation failure for well-formed JSON that violates the schema", () => {
		const result = parseJsonSafe(schema, '{"name":"x","count":"not-a-number"}', "payload");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Validation failed (payload)");
		}
	});
});

describe("parseJsonUntyped", () => {
	it("returns the parsed value without a schema", () => {
		const result = parseJsonUntyped('{"a":[1,2,3]}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ a: [1, 2, 3] });
		}
	});

	it("reports a parse failure with the context label", () => {
		const result = parseJsonUntyped("<<<", "relay-payload");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("JSON parse failed (relay-payload)");
		}
	});

	it("omits the parenthetical when no context is given", () => {
		const result = parseJsonUntyped("<<<");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toStartWith("JSON parse failed:");
		}
	});
});
