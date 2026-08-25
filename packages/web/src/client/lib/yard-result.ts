export interface FormattedYardResult {
	display: string;
	hint: string;
	isJson: boolean;
}

function isSensitiveResultKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		normalized === "redacted_data" ||
		normalized === "signature" ||
		normalized === "signatures" ||
		/(?:reasoning|thinking).*?(?:encrypted|signature)/.test(normalized)
	);
}

function isEmptyThinkingBlock(value: Record<string, unknown>): boolean {
	if (value.type !== "thinking") return false;
	return Object.entries(value).every(
		([key, entry]) => key === "type" || (key === "thinking" && !entry),
	);
}

/** Returns a presentation-only copy that excludes opaque encrypted reasoning and signatures. */
export function sanitizeYardResult(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.map(sanitizeYardResult)
			.filter((entry) => !(isRecord(entry) && isEmptyThinkingBlock(entry)));
	}
	if (!isRecord(value)) return value;

	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isSensitiveResultKey(key)) sanitized[key] = sanitizeYardResult(entry);
	}
	return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sizeHint(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function jsonType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value === "object" ? "object" : typeof value;
}

/** Formats raw persisted result content for disclosure without changing the persisted value. */
export function formatYardResult(raw: string): FormattedYardResult {
	const bytes = new TextEncoder().encode(raw).byteLength;
	try {
		const value = JSON.parse(raw);
		return {
			display: JSON.stringify(sanitizeYardResult(value), null, 2),
			hint: `JSON ${jsonType(value)} · ${sizeHint(bytes)}`,
			isJson: true,
		};
	} catch {
		return { display: raw, hint: `plain text · ${sizeHint(bytes)}`, isJson: false };
	}
}
