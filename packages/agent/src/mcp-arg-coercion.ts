/**
 * MCP argument coercion.
 *
 * The bash `--key value` parser produces strings for every argument value.
 * MCP servers validate arguments against each tool's JSON Schema and reject
 * mistyped values (e.g. "160" where a number is expected, "true" where a
 * boolean is expected). These helpers coerce string values to the JS types
 * declared by a tool's inputSchema before dispatch.
 *
 * Shared by both dispatch paths so behavior is identical regardless of where
 * the MCP server lives:
 *   - local path  → mcp-bridge.ts generateMCPCommands (callTool directly)
 *   - relay path  → relay-processor.ts executeToolCall (forwarded tool_call)
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Attempt to parse a string as JSON; returns undefined on failure. */
export function parseJsonValue(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/** JSON Schema property with the fields we care about for coercion. */
export type PropSchema = { type?: string | string[]; enum?: string[]; items?: unknown };

/**
 * Check whether a JSON Schema property definition declares a given type.
 * Handles both scalar (`type: "string"`) and union (`type: ["string", "null"]`) forms.
 */
export function hasType(propSchema: PropSchema, typeName: string): boolean {
	const { type } = propSchema;
	if (!type) return false;
	return Array.isArray(type) ? type.includes(typeName) : type === typeName;
}

/**
 * Coerce a single string value to the JS type declared by a JSON Schema property.
 *
 * Handles: array, object, number/integer, boolean, enum, and a safety case for
 * scalar params that received a JSON array string via preserveRepeatedFlags.
 */
export function coerceStringValue(value: string, propSchema: PropSchema): unknown {
	// Array: parse JSON array string, or wrap a lone value in a single-element array.
	if (hasType(propSchema, "array")) {
		const parsed = parseJsonValue(value);
		if (Array.isArray(parsed)) return parsed;
		return [value];
	}

	// Object: parse JSON object string, fall back to original string on failure.
	if (hasType(propSchema, "object")) {
		const parsed = parseJsonValue(value);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return value;
	}

	// Safety: value is a JSON array string but the schema type is scalar.
	// preserveRepeatedFlags may have accumulated --flag a --flag b as '["a","b"]'.
	// Extract the last element (preserving last-wins semantics) and recurse so
	// that the underlying type coercions still apply to the extracted value.
	const parsedSafety = parseJsonValue(value);
	if (Array.isArray(parsedSafety) && parsedSafety.length > 0) {
		const last = parsedSafety[parsedSafety.length - 1];
		return typeof last === "string" ? coerceStringValue(last, propSchema) : last;
	}

	// Number / integer
	if (hasType(propSchema, "number") || hasType(propSchema, "integer")) {
		const n = Number(value);
		if (!Number.isNaN(n)) return n;
		return value;
	}

	// Boolean
	if (hasType(propSchema, "boolean")) {
		if (value === "true") return true;
		if (value === "false") return false;
		return value;
	}

	// Enum: case-insensitive match
	if (propSchema.enum && propSchema.enum.length > 0) {
		const match = propSchema.enum.find((e) => e.toLowerCase() === value.toLowerCase());
		if (match !== undefined) return match;
	}

	return value;
}

/**
 * Coerce string argument values to the types declared in an MCP tool's input schema.
 * The bash --key value parser produces strings for all values; MCP servers validate
 * against their JSON Schema and reject e.g. "10" when number is expected. This function
 * uses the schema's property types and enum values to convert args in place.
 *
 * When the command was generated with preserveRepeatedFlags: true, repeated flags
 * like --tag a --tag b arrive as a JSON array string '["a","b"]'. For array-typed
 * params this is decoded to a JS array; for scalar-typed params the last element is
 * extracted, preserving last-wins semantics and preventing raw JSON strings from
 * reaching the tool.
 */
export function coerceArgsFromSchema(
	args: Record<string, unknown>,
	inputSchema: Tool["inputSchema"] | undefined,
): Record<string, unknown> {
	if (!inputSchema || typeof inputSchema !== "object") return args;
	const schema = inputSchema as { properties?: Record<string, PropSchema> };
	const props = schema.properties;
	if (!props) return args;

	const coerced: Record<string, unknown> = { ...args };
	for (const [key, value] of Object.entries(coerced)) {
		if (typeof value !== "string") continue;
		const propSchema = props[key];
		if (!propSchema) continue;
		coerced[key] = coerceStringValue(value, propSchema);
	}
	return coerced;
}
