/**
 * Tool conversion: Bound's ToolDefinition[] → AI SDK ToolSet via jsonSchema()
 * so we don't force a zod round-trip. Schemas pass through unchanged.
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
