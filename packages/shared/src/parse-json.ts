import type { z } from "zod";
import type { Result } from "./result.js";

/**
 * Parse a JSON string and validate against a Zod schema. Returns a Result
 * so callers can handle failures without try-catch boilerplate.
 *
 * @example
 * ```ts
 * const result = parseJsonSafe(toolCallPayloadSchema, entry.payload, "tool_call");
 * if (!result.ok) {
 *   logger.error("Invalid payload", { error: result.error });
 *   return;
 * }
 * const payload = result.value; // fully typed
 * ```
 */
export function parseJsonSafe<T>(
	schema: z.ZodType<T>,
	json: string,
	context?: string,
): Result<T, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			error: `JSON parse failed${context ? ` (${context})` : ""}: ${msg}`,
		};
	}

	const result = schema.safeParse(parsed);
	if (!result.success) {
		return {
			ok: false,
			error: `Validation failed${context ? ` (${context})` : ""}: ${result.error.message}`,
		};
	}

	return { ok: true, value: result.data };
}

/**
 * Parse a JSON string without schema validation, returning a Result instead
 * of throwing. Use when you need structured error handling but don't have a
 * schema (or the schema is too complex to define upfront).
 */
export function parseJsonUntyped(json: string, context?: string): Result<unknown, string> {
	try {
		return { ok: true, value: JSON.parse(json) };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			error: `JSON parse failed${context ? ` (${context})` : ""}: ${msg}`,
		};
	}
}
