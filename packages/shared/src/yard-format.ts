/**
 * Yard presentation-value formatting, shared by the web UI and the TUI
 * (#243). Owns JSON/object-literal detection, persistence-envelope
 * unwrapping, sensitive-field sanitization, and the classification hint —
 * so a Yard result renders identically in YardExecutionPanel.svelte and
 * boundless's YardExecutionCard. Pure module: no imports, no I/O.
 */

export interface FormattedYardValue {
	display: string;
	hint: string;
	isJson: boolean;
	/** The source was a JavaScript object literal with dynamic expressions. */
	isJavaScript?: boolean;
	tail?: string;
}

/** @deprecated Use FormattedYardValue; retained for result consumers. */
export type FormattedYardResult = FormattedYardValue;

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
	if (!isRecord(value) || !("result" in value)) return value;
	const envelopeKeys = new Set(["result", "trace_id", "usage"]);
	if (!Object.keys(value).every((key) => envelopeKeys.has(key))) return value;
	return value.result;
}

function unwrapTextContentBlocks(value: unknown): unknown {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every(
			(block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
	)
		return value;
	return value.map((block) => (block as { text: string }).text).join("\n");
}

interface ParsedJsonValue {
	value: unknown;
	tail?: string;
}

/** Parses one complete JSON value at the beginning of text, retaining any presentation metadata after it. */
export function parseLeadingJsonValue(raw: string): ParsedJsonValue | undefined {
	try {
		return { value: JSON.parse(raw) };
	} catch {
		// Persisted tool output can append markers such as "[duration: 900.005s]" after JSON.
	}

	const start = raw.search(/\S/);
	if (start === -1 || (raw[start] !== "{" && raw[start] !== "[")) return undefined;

	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < raw.length; index++) {
		const character = raw[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") stack.push(character);
		else if (character === "}" || character === "]") {
			const opening = stack.pop();
			if ((character === "}" && opening !== "{") || (character === "]" && opening !== "["))
				return undefined;
			if (stack.length === 0) {
				try {
					const value = JSON.parse(raw.slice(start, index + 1));
					const tail = raw.slice(index + 1).trim();
					return { value, ...(tail ? { tail } : {}) };
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/** Resolves persistence wrappers before classifying and rendering one presentation value. */
function unwrapPersistedYardValue(value: unknown, tail?: string): ParsedJsonValue {
	let current = value;
	let currentTail = tail;
	for (let i = 0; i < 4; i++) {
		const unwrapped = unwrapYardResultEnvelope(unwrapTextContentBlocks(current));
		if (typeof unwrapped !== "string") {
			if (unwrapped === current)
				return { value: current, ...(currentTail ? { tail: currentTail } : {}) };
			current = unwrapped;
			continue;
		}
		const parsed = parseLeadingJsonValue(unwrapped);
		if (!parsed) return { value: unwrapped, ...(currentTail ? { tail: currentTail } : {}) };
		current = parsed.value;
		currentTail ??= parsed.tail;
	}
	return { value: current, ...(currentTail ? { tail: currentTail } : {}) };
}

function extractObjectLiteral(raw: string): { source: string; tail?: string } | undefined {
	const start = raw.search(/\S/);
	if (start === -1 || raw[start] !== "{") return undefined;

	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = start; index < raw.length; index++) {
		const character = raw[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "{") depth++;
		else if (character === "}" && --depth === 0) {
			const source = raw.slice(start, index + 1);
			const tail = raw.slice(index + 1).trim();
			return { source, ...(tail ? { tail } : {}) };
		}
	}
	return undefined;
}

function parseObjectLiteral(raw: string): ParsedJsonValue | undefined {
	const literal = extractObjectLiteral(raw);
	if (!literal) return undefined;
	// Static topology extraction owns these literals. Quote its bare keys so
	// presentation remains JSON without evaluating program source.
	const json = literal.source.replace(/([,{]\s*)([$A-Z_a-z][$\w]*)(\s*:)/g, '$1"$2"$3');
	try {
		return { value: JSON.parse(json), ...(literal.tail ? { tail: literal.tail } : {}) };
	} catch {
		return undefined;
	}
}

/** Counts `key: value` fields without evaluating dynamic JavaScript expressions. */
function countTopLevelObjectKeys(source: string): number | undefined {
	const fields: string[] = [];
	let fieldStart = 1;
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = 1; index < source.length - 1; index++) {
		const character = source[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "{" || character === "[" || character === "(") depth++;
		else if (character === "}" || character === "]" || character === ")") depth--;
		else if (character === "," && depth === 0) {
			fields.push(source.slice(fieldStart, index));
			fieldStart = index + 1;
		}
	}
	const finalField = source.slice(fieldStart, -1);
	if (finalField.trim()) fields.push(finalField);
	return fields.every((field) => {
		let nested = 0;
		let inQuote = "";
		let isEscaped = false;
		for (const character of field) {
			if (inQuote) {
				if (isEscaped) isEscaped = false;
				else if (character === "\\") isEscaped = true;
				else if (character === inQuote) inQuote = "";
				continue;
			}
			if (character === '"' || character === "'" || character === "`") inQuote = character;
			else if (character === "{" || character === "[" || character === "(") nested++;
			else if (character === "}" || character === "]" || character === ")") nested--;
			else if (character === ":" && nested === 0) return true;
		}
		return false;
	})
		? fields.length
		: undefined;
}

/** Removes call-site indentation from captured source without changing its relative structure. */
function normalizeSourceIndentation(source: string): string {
	const lines = source.split(/\r?\n/);
	if (lines.length < 2) return source;

	const normalized = lines.map((line) =>
		line.replace(/^([ \t]*)/, (indent) => indent.replaceAll("\t", "  ")),
	);
	const indents = normalized
		.slice(1)
		.filter((line) => line.trim())
		.map((line) => line.match(/^ */)?.[0].length ?? 0);
	const commonIndent = indents.length === 0 ? 0 : Math.min(...indents);
	if (commonIndent === 0) return normalized.join("\n");
	return normalized
		.map((line, index) => (index === 0 ? line : line.slice(Math.min(commonIndent, line.length))))
		.join("\n");
}

/** Formats any Yard presentation value consistently without changing persistence data. */
export function formatYardValue(raw: string): FormattedYardValue {
	const bytes = new TextEncoder().encode(raw).byteLength;
	const parsed = parseLeadingJsonValue(raw) ?? parseObjectLiteral(raw);
	if (!parsed) {
		const literal = extractObjectLiteral(raw);
		const keyCount = literal && countTopLevelObjectKeys(literal.source);
		if (literal && keyCount !== undefined) {
			return {
				display: normalizeSourceIndentation(literal.source),
				hint: `object · ${keyCount} ${keyCount === 1 ? "key" : "keys"} · ${sizeHint(bytes)}`,
				isJson: false,
				isJavaScript: true,
				...(literal.tail ? { tail: literal.tail } : {}),
			};
		}
		return { display: raw, hint: `string · ${sizeHint(bytes)}`, isJson: false };
	}

	const { value, tail } = unwrapPersistedYardValue(parsed.value, parsed.tail);
	const sanitized = sanitizeYardResult(value);
	return {
		display: JSON.stringify(sanitized, null, 2),
		hint: classifyYardResult(sanitized, bytes),
		isJson: true,
		...(tail ? { tail } : {}),
	};
}

export type YardValueLanguage = "javascript" | "json" | "text";

/** Applies the shared formatter to inspector values, preserving source programs as JavaScript. */
export function formatYardInspectorValue(
	raw: string,
	key: string,
): FormattedYardValue & { lang: YardValueLanguage } {
	const formatted = formatYardValue(raw);
	return {
		...formatted,
		display:
			key === "program"
				? normalizeSourceIndentation(raw)
				: formatted.isJson
					? formatted.display
					: ["prompt", "schema", "instructions"].includes(key)
						? normalizeSourceIndentation(formatted.display)
						: formatted.display,
		lang:
			key === "program" || formatted.isJavaScript
				? "javascript"
				: formatted.isJson
					? "json"
					: "text",
	};
}

/** @deprecated Use formatYardValue; retained for result consumers. */
export const formatYardResult = formatYardValue;
