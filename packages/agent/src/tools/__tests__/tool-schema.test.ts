import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineToolSchema, parseToolInput, zodToToolParams } from "../tool-schema";

// Mirrors the shape of the grouped native tools (memory/advisory): a required
// `action` enum plus a pile of per-action-irrelevant optional params.
const sampleSchema = z.object({
	action: z.enum(["store", "forget"]),
	key: z.string().optional(),
	value: z.string().optional(),
	weight: z.number().optional(),
	tier: z.enum(["pinned", "default"]).optional(),
});

describe("defineToolSchema", () => {
	it("preserves the legacy function-definition shape exactly", () => {
		const name = "sample";
		const description = "Sample tool";
		const legacyDefinition = {
			type: "function" as const,
			function: { name, description, parameters: zodToToolParams(sampleSchema) },
		};

		expect(defineToolSchema(name, description, sampleSchema).definition).toEqual(legacyDefinition);
	});

	it("treats wire null as absent for optional params", () => {
		// The model-facing JSONSchema marks optional params as nullable (the AI
		// SDK `withNullableType` transform), so the model passes null for the
		// params that don't apply to the chosen action. The validator must accept
		// that rather than reject with "expected string, received null".
		const result = defineToolSchema("sample", "Sample tool", sampleSchema).safeParse({
			action: "store",
			key: "k",
			value: "v",
			weight: null,
			tier: null,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.action).toBe("store");
			expect(result.value.key).toBe("k");
			// null params drop out as absent, not null.
			expect(result.value.weight).toBeUndefined();
			expect(result.value.tier).toBeUndefined();
		}
	});

	it("accepts null for every optional param at once", () => {
		const result = parseToolInput(
			sampleSchema,
			{ action: "forget", key: null, value: null, weight: null, tier: null },
			"sample",
		);
		expect(result.ok).toBe(true);
	});

	it("returns the legacy validation error for malformed input", () => {
		const raw = { action: "store", weight: "not-a-number" };
		expect(defineToolSchema("sample", "Sample tool", sampleSchema).safeParse(raw)).toEqual(
			parseToolInput(sampleSchema, raw, "sample"),
		);
	});

	it("still rejects a genuine type mismatch, without the misleading truncation suffix", () => {
		const result = parseToolInput(
			sampleSchema,
			{ action: "store", weight: "not-a-number" },
			"sample",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// The real cause must be named...
			expect(result.error).toContain("weight");
			// ...and the error must NOT blame output-token truncation, which sent
			// readers chasing a non-existent problem (advisory 6d6fde4f).
			expect(result.error.toLowerCase()).not.toContain("truncated");
		}
	});
});
