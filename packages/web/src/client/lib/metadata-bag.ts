/** Parse a message's `metadata` property bag, accepting the raw JSON-string (API/WS) form. */
export function readMetadataBag(metadata: unknown): Record<string, unknown> | undefined {
	if (metadata == null) return undefined;
	let bag: unknown = metadata;
	if (typeof metadata === "string") {
		try {
			bag = JSON.parse(metadata);
		} catch {
			return undefined;
		}
	}
	if (typeof bag !== "object" || bag === null || Array.isArray(bag)) return undefined;
	return bag as Record<string, unknown>;
}
