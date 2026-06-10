import type { ToolDefinition } from "@bound/llm";
import { type ZodObject, type ZodRawShape, z } from "zod";

export function zodToToolParams<T extends ZodRawShape>(
	schema: ZodObject<T>,
): Record<string, unknown> {
	const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
	return rest;
}

/**
 * The model-facing JSONSchema marks optional params as nullable: the AI SDK's
 * `withNullableType` transform (packages/llm/src/ai-sdk-bridge.ts) expresses
 * optionality as `| null` for strict providers, which require every property in
 * `required`. Models therefore pass `null` for the params that don't apply to
 * the chosen action. But Zod `.optional()` means `| undefined`, not `| null`,
 * so a literal `null` would be rejected ("expected string, received null").
 * Coerce a top-level `null` to absent before validating, matching the contract
 * the model was actually handed. Shallow by design — these grouped tools take
 * flat params, and no native tool treats `null` as a meaningful distinct value.
 */
function nullsToAbsent(input: Record<string, unknown>): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== null) out[key] = value;
	}
	return out;
}

export function defineToolSchema<T extends ZodRawShape>(
	name: string,
	description: string,
	schema: ZodObject<T>,
): {
	definition: ToolDefinition;
	parse: (input: Record<string, unknown>) => z.infer<ZodObject<T>>;
} {
	return {
		definition: {
			type: "function",
			function: { name, description, parameters: zodToToolParams(schema) },
		},
		parse: (input: Record<string, unknown>) => schema.parse(nullsToAbsent(input)),
	};
}

export function parseToolInput<T extends ZodRawShape>(
	schema: ZodObject<T>,
	input: Record<string, unknown>,
	toolName: string,
): { ok: true; value: z.infer<ZodObject<T>> } | { ok: false; error: string } {
	const result = schema.safeParse(nullsToAbsent(input));
	if (result.success) {
		return { ok: true, value: result.data };
	}
	const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
	return {
		ok: false,
		error: `Error: invalid parameters for "${toolName}": ${issues}. Check each value against the tool's parameter schema; omit (or pass null for) optional params that don't apply to this action.`,
	};
}
