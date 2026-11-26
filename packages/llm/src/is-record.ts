/** A non-null, non-array object — the shape of a parsed JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
