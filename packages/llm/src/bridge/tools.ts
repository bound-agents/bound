/**
 * Tool conversion: Bound's ToolDefinition[] → AI SDK ToolSet via jsonSchema()
 * so we don't force a zod round-trip. Includes the JSON-schema strictifier
 * that adds `additionalProperties: false` / nullable-optional handling for
 * providers (OpenAI) that require strict schemas.
 */

import { tool as aiTool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { ToolDefinition } from "../types";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIncludesType(schema: JsonObject, type: string): boolean {
	const schemaType = schema.type;
	if (schemaType === type) return true;
	return Array.isArray(schemaType) && schemaType.includes(type);
}

function hasObjectShape(schema: JsonObject): boolean {
	return schemaIncludesType(schema, "object") || isJsonObject(schema.properties);
}

function withNullableType(schema: JsonObject): JsonObject {
	const out = { ...schema };
	const schemaType = out.type;
	if (out.const !== undefined) {
		return { anyOf: [out, { type: "null" }] };
	}
	if (Array.isArray(out.enum)) {
		out.enum = out.enum.includes(null) ? [...out.enum] : [...out.enum, null];
	}
	if (Array.isArray(schemaType)) {
		out.type = schemaType.includes("null") ? [...schemaType] : [...schemaType, "null"];
	} else if (schemaType !== undefined && schemaType !== "null") {
		out.type = [schemaType, "null"];
	} else if (schemaType === undefined && !Array.isArray(out.enum)) {
		// Shape-only schemas (`anyOf`, `$ref`, etc.) can't be made nullable by
		// overwriting `type` without changing their meaning. Wrap instead.
		return { anyOf: [out, { type: "null" }] };
	}
	return out;
}

function hasDeliberatelyOpenObject(schema: unknown): boolean {
	if (!isJsonObject(schema)) return false;
	if (hasObjectShape(schema)) {
		// `additionalProperties: true` is used for intentional pass-through tools
		// (notably MCP server dispatch). A schema-valued additionalProperties is
		// also an open map; forcing it closed would change the tool contract.
		if (schema.additionalProperties === true || isJsonObject(schema.additionalProperties)) {
			return true;
		}
		if (isJsonObject(schema.patternProperties)) return true;
	}
	for (const value of Object.values(schema)) {
		if (Array.isArray(value)) {
			if (value.some((item) => hasDeliberatelyOpenObject(item))) return true;
		} else if (hasDeliberatelyOpenObject(value)) {
			return true;
		}
	}
	return false;
}

function strictifyJsonSchema(schema: unknown, optional = false): unknown {
	if (Array.isArray(schema)) return schema.map((item) => strictifyJsonSchema(item));
	if (!isJsonObject(schema)) return schema;

	let out: JsonObject = { ...schema };
	if (isJsonObject(out.properties) && hasObjectShape(out)) {
		const required = new Set(Array.isArray(out.required) ? out.required : []);
		const properties: JsonObject = {};
		for (const [key, value] of Object.entries(out.properties)) {
			properties[key] = strictifyJsonSchema(value, !required.has(key));
		}
		out.properties = properties;
		out.required = Object.keys(properties);
		out.additionalProperties = false;
	}
	if (Array.isArray(out.items)) {
		out.items = out.items.map((item) => strictifyJsonSchema(item));
	} else if (isJsonObject(out.items)) {
		out.items = strictifyJsonSchema(out.items);
	}
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		if (Array.isArray(out[key])) {
			out[key] = out[key].map((item) => strictifyJsonSchema(item));
		}
	}
	if (optional) out = withNullableType(out);
	return out;
}

function projectToolParameters(
	parameters: Record<string, unknown>,
	opts: { emitStrictFlag?: boolean } = {},
): {
	schema: Record<string, unknown>;
	strict?: true;
} {
	if (hasDeliberatelyOpenObject(parameters)) return { schema: parameters };
	return {
		schema: strictifyJsonSchema(parameters) as Record<string, unknown>,
		...(opts.emitStrictFlag !== false && { strict: true as const }),
	};
}

export function toToolSet(
	tools?: ToolDefinition[],
	opts: { emitStrictFlag?: boolean } = {},
): ToolSet | undefined {
	if (!tools || tools.length === 0) return undefined;
	const result: ToolSet = {};
	for (const t of tools) {
		const { schema, strict } = projectToolParameters(t.function.parameters, opts);
		result[t.function.name] = aiTool({
			description: t.function.description,
			inputSchema: jsonSchema(schema),
			...(strict && { strict }),
		});
	}
	return result;
}
