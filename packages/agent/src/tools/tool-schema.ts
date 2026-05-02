import type { ToolDefinition } from "@bound/llm";
import { type ZodObject, type ZodRawShape, z } from "zod";

export function zodToToolParams<T extends ZodRawShape>(
	schema: ZodObject<T>,
): Record<string, unknown> {
	const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
	return rest;
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
		parse: (input: Record<string, unknown>) => schema.parse(input),
	};
}

export function parseToolInput<T extends ZodRawShape>(
	schema: ZodObject<T>,
	input: Record<string, unknown>,
	toolName: string,
): { ok: true; value: z.infer<ZodObject<T>> } | { ok: false; error: string } {
	const result = schema.safeParse(input);
	if (result.success) {
		return { ok: true, value: result.data };
	}
	const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
	return {
		ok: false,
		error: `Error: invalid parameters for "${toolName}": ${issues}. This may indicate the tool call was truncated by the output token limit.`,
	};
}
