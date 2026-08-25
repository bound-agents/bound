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

export function classifyYardResult(value: unknown, bytes: number): string {
	if (Array.isArray(value)) {
		return `array · ${value.length} ${value.length === 1 ? "item" : "items"} · ${sizeHint(bytes)}`;
	}
	if (isRecord(value)) {
		const keyCount = Object.keys(value).length;
		return `object · ${keyCount} ${keyCount === 1 ? "key" : "keys"} · ${sizeHint(bytes)}`;
	}
	return `${value === null ? "null" : typeof value} · ${sizeHint(bytes)}`;
}

function unwrapYardResultEnvelope(value: unknown): unknown {
	if (!isRecord(value) || Object.keys(value).length !== 1 || !("result" in value)) return value;
	return value.result;
}

function parseNestedJsonString(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** Formats raw persisted result content for disclosure without changing the persisted value. */
export function formatYardResult(raw: string): FormattedYardResult {
	const bytes = new TextEncoder().encode(raw).byteLength;
	try {
		const parsed = JSON.parse(raw);
		const value = parseNestedJsonString(unwrapYardResultEnvelope(parsed));
		const sanitized = sanitizeYardResult(value);
		return {
			display: JSON.stringify(sanitized, null, 2),
			hint: classifyYardResult(sanitized, bytes),
			isJson: true,
		};
	} catch {
		return { display: raw, hint: `plain text · ${sizeHint(bytes)}`, isJson: false };
	}
}
