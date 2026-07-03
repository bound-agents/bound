/**
 * Tool conversion: Bound's ToolDefinition[] → AI SDK ToolSet via jsonSchema()
 * so we don't force a zod round-trip. Schemas pass through unchanged.
 *
 * A strict-schema projection (all properties required, optionals rewritten
 * nullable, additionalProperties: false, strict: true flag) lived here from
 * 2072ca28 to its removal: it was added for gpt-5.5 tool-calling, determined
 * not to help, and its half-revert (78e08d15) only stopped emitting the flag
 * on the Bedrock driver while every driver kept receiving projected schemas.
 * The projection also advertised `null` as valid for optional params that
 * runtime zod validation then rejected. Optionals are simply optional again.
 */

import { tool as aiTool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { ToolDefinition } from "../types";

export function toToolSet(tools?: ToolDefinition[]): ToolSet | undefined {
	if (!tools || tools.length === 0) return undefined;
	const result: ToolSet = {};
	for (const t of tools) {
		result[t.function.name] = aiTool({
			description: t.function.description,
			inputSchema: jsonSchema(t.function.parameters as Record<string, unknown>),
		});
	}
	return result;
}
