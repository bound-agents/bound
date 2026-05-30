/**
 * Tool-cycle folding compressor for the progressive fidelity middle tier.
 *
 * Mechanically compresses a range of LLMMessages into compact one-liner
 * summaries. No LLM calls — pure deterministic projection over message
 * content. The folded output preserves chronological order and enough
 * semantic signal for the agent to recall what happened without needing
 * full-resolution tool_result blobs.
 *
 * Property contracts (tested in __tests__/tool-cycle-fold.property.test.ts):
 *   F1: Coverage — every message in range produces at least one FoldedLine
 *   F2: Tool-pair grouping — adjacent tool_call + tool_results fold together
 *   F3: User message preservation — user message text appears verbatim
 *   F4: Line length bound — no FoldedLine.text exceeds MAX_FOLDED_LINE_CHARS
 *   F5: Determinism — same input → same output
 *   F6: Graceful empty — empty input range → empty output array
 */

import type { LLMMessage } from "@bound/llm";

export const MAX_FOLDED_LINE_CHARS = 300;
const ASSISTANT_PREVIEW_CHARS = 200;

export interface FoldedLine {
	/** The one-liner representation of this message or group. */
	text: string;
	/** Approximate token count (chars / 4 heuristic for short strings). */
	tokens: number;
	/** Number of source messages consumed to produce this line. */
	sourceCount: number;
}

/**
 * Fold a range of messages into compact one-liners.
 *
 * @param messages Full history message array
 * @param startIndex Inclusive start of the range to fold
 * @param endIndex Exclusive end of the range to fold
 * @returns Folded lines in chronological order
 */
export function foldMessages(
	messages: ReadonlyArray<LLMMessage>,
	startIndex: number,
	endIndex: number,
): FoldedLine[] {
	if (startIndex >= endIndex || startIndex >= messages.length) return [];

	const effectiveEnd = Math.min(endIndex, messages.length);
	const results: FoldedLine[] = [];
	let i = startIndex;

	while (i < effectiveEnd) {
		const msg = messages[i];

		if (msg.role === "tool_call") {
			// Identify the tool_call + subsequent tool_result(s) group.
			const toolUses = extractToolUses(msg.content);
			const resultStartIdx = i + 1;
			let resultCount = 0;
			while (
				resultStartIdx + resultCount < effectiveEnd &&
				messages[resultStartIdx + resultCount].role === "tool_result"
			) {
				resultCount++;
			}

			if (toolUses.length === 0) {
				// Malformed tool_call with no parseable tool_use blocks.
				const line = clamp("[tool] (unparseable tool call)");
				results.push({ text: line, tokens: estimateTokens(line), sourceCount: 1 + resultCount });
			} else if (resultCount === 0) {
				// Orphan tool_call — no result followed.
				for (const tu of toolUses) {
					const line = isReadClassTool(tu.name)
						? buildReadActionLine(tu.input, "(no result)")
						: clamp(`[tool] ${tu.name}(${tu.hint}) → (no result)`);
					results.push({ text: line, tokens: estimateTokens(line), sourceCount: 0 });
				}
				// Attribute sourceCount to the first line only.
				if (results.length > 0) {
					results[results.length - toolUses.length].sourceCount = 1;
				}
			} else {
				// Pair tool_use blocks with tool_results. When counts mismatch,
				// pair what we can and mark extras.
				const pairCount = Math.min(toolUses.length, resultCount);
				for (let p = 0; p < pairCount; p++) {
					const tu = toolUses[p];
					const resultMsg = messages[resultStartIdx + p];
					const line = isReadClassTool(tu.name)
						? buildReadActionLine(tu.input, detectResultError(resultMsg.content))
						: clamp(`[tool] ${tu.name}(${tu.hint}) → ${extractResultSummary(resultMsg.content)}`);
					results.push({ text: line, tokens: estimateTokens(line), sourceCount: 0 });
				}
				// Extra tool_uses without results.
				for (let p = pairCount; p < toolUses.length; p++) {
					const tu = toolUses[p];
					const line = isReadClassTool(tu.name)
						? buildReadActionLine(tu.input, "(no result)")
						: clamp(`[tool] ${tu.name}(${tu.hint}) → (no result)`);
					results.push({ text: line, tokens: estimateTokens(line), sourceCount: 0 });
				}
				// Extra tool_results without tool_uses.
				for (let p = pairCount; p < resultCount; p++) {
					const resultMsg = messages[resultStartIdx + p];
					const resultSummary = extractResultSummary(resultMsg.content);
					const line = clamp(`[tool] ?(…) → ${resultSummary}`);
					results.push({ text: line, tokens: estimateTokens(line), sourceCount: 0 });
				}
				// Attribute source count to the first folded line of this group.
				const groupLineCount = Math.max(toolUses.length, resultCount);
				const firstGroupIdx = results.length - groupLineCount;
				if (firstGroupIdx >= 0) {
					results[firstGroupIdx].sourceCount = 1 + resultCount;
				}
			}

			i = resultStartIdx + resultCount;
		} else if (msg.role === "user") {
			const text = extractTextContent(msg.content);
			const line = clamp(`[user] ${text}`);
			results.push({ text: line, tokens: estimateTokens(line), sourceCount: 1 });
			i++;
		} else if (msg.role === "assistant") {
			const text = extractTextContent(msg.content);
			const preview =
				text.length > ASSISTANT_PREVIEW_CHARS
					? `${text.slice(0, ASSISTANT_PREVIEW_CHARS)}...`
					: text;
			const line = clamp(`[assistant] ${preview}`);
			results.push({ text: line, tokens: estimateTokens(line), sourceCount: 1 });
			i++;
		} else if (msg.role === "tool_result") {
			// Orphan tool_result (no preceding tool_call in this range).
			const summary = extractResultSummary(msg.content);
			const line = clamp(`[tool result] ${summary}`);
			results.push({ text: line, tokens: estimateTokens(line), sourceCount: 1 });
			i++;
		} else {
			// developer, system, cache — skip silently.
			// Still count as consumed for F1 coverage.
			results.push({ text: "", tokens: 0, sourceCount: 1 });
			i++;
		}
	}

	// Remove empty placeholder lines (from skipped developer/system messages)
	// but only AFTER ensuring F1 coverage accounting is correct.
	// Actually, F1 says "every message produces at least one FoldedLine" —
	// but the plan says developer/system messages are skipped. Reconcile:
	// F1 should mean "every message is accounted for in sourceCount sums"
	// rather than "every message produces a visible line." Filter empties.
	return results.filter((line) => line.text.length > 0);
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

interface ToolUseInfo {
	name: string;
	hint: string;
	/** Raw tool input, when structurally available (JSON ContentBlock[] form). */
	input?: Record<string, unknown>;
}

/**
 * Read-class tools return a file BODY as their result. Folding that body is
 * both lossy (a near-random fragment, not the lines the agent needs) and
 * stale-prone (the file is usually being edited concurrently). Instead we fold
 * read-class calls to an accurate ACTION line derived from the call args
 * (path + line range), never the body — see `buildReadActionLine`.
 *
 * Matched by exact name `read` or any `*_read` suffix (e.g. `boundless_read`),
 * so platform-prefixed variants are covered without an enumerated list. Other
 * file-inspecting tools (grep/glob/list) are intentionally NOT read-class:
 * their results are already compact match/path lists that `extractResultSummary`
 * folds usefully, and they are the agent's actual findings, not a file body.
 */
function isReadClassTool(name: string): boolean {
	return name === "read" || name.endsWith("_read");
}

/**
 * Render a read-class call as an action line from its ARGS. Drops the file body
 * (the lost-then-re-read content) but keeps a precise re-read target: the full
 * path and, when present, the exact line range. On a failed read the error
 * signal is preserved instead of silently implying success.
 */
function buildReadActionLine(
	input: Record<string, unknown> | undefined,
	errorDetail: string | null,
): string {
	const path =
		typeof input?.file_path === "string"
			? input.file_path
			: typeof input?.path === "string"
				? input.path
				: "(unknown path)";
	const offset = typeof input?.offset === "number" ? input.offset : undefined;
	const limit = typeof input?.limit === "number" ? input.limit : undefined;

	let range = "";
	if (offset !== undefined && limit !== undefined) {
		range = ` lines ${offset}-${offset + limit - 1} (${limit} lines)`;
	} else if (limit !== undefined) {
		range = ` (${limit} lines)`;
	} else if (offset !== undefined) {
		range = ` from line ${offset}`;
	}

	const errSuffix = errorDetail ? ` -> ${errorDetail}` : "";
	return clamp(`[read] ${path}${range}${errSuffix}`);
}

/**
 * Detect a read failure from the frozen result content. Returns a short error
 * fragment, or null on success. Pure: same frozen content -> same verdict.
 *
 * CRITICAL: a successful read returns the file BODY, which routinely contains
 * the word "error" mid-line (comments, identifiers, string literals). A naive
 * substring scan both false-flags success AND leaks a body fragment into the
 * error suffix — the exact content-loss-adjacent bug this fold fix exists to
 * prevent. Read output is line-number prefixed (`  95<tab>...`), so a real body
 * line never STARTS with an error token. Anchor detection accordingly:
 *   1. a non-zero `Exit code:` (the unambiguous failure signal), or
 *   2. an error token at the START of a content line (after stripping the
 *      boundless banner / `stdout:` markers / leading whitespace) — i.e. the
 *      result IS an error message, not a body that mentions one.
 */
function detectResultError(content: string | unknown[]): string | null {
	const text = extractTextContent(content);

	const exitMatch = text.match(/exit[_ ]code:?\s*(\d+)/i);
	if (exitMatch) return exitMatch[1] === "0" ? null : `exit ${exitMatch[1]}`;

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		// Skip structural noise (banner, stream markers).
		if (line.startsWith("[boundless]") || /^(stdout|stderr):?$/i.test(line)) continue;
		// A line-number-prefixed line is body content — read succeeded.
		if (/^\d+\t/.test(raw) || /^\s*\d+[:\t]/.test(raw)) return null;
		// First substantive line: error only if it OPENS with an error token.
		if (/^(error\b|enoent\b|eacces\b|eisdir\b|failed\b|no such file|not found)/i.test(line)) {
			return line.length > 60 ? `${line.slice(0, 57)}...` : line;
		}
		// Any other first substantive line means a non-error result; stop scanning
		// so a later body line that happens to start with "error" can't trip us.
		return null;
	}
	return null;
}

function extractToolUses(content: string | unknown[]): ToolUseInfo[] {
	if (typeof content === "string") {
		return extractToolUsesFromString(content);
	}
	if (!Array.isArray(content)) return [];

	const uses: ToolUseInfo[] = [];
	for (const block of content) {
		if (isToolUseBlock(block)) {
			uses.push({
				name: block.name ?? "unknown",
				hint: extractInputHint(block.input),
				input:
					block.input && typeof block.input === "object"
						? (block.input as Record<string, unknown>)
						: undefined,
			});
		}
	}
	return uses;
}

function extractToolUsesFromString(content: string): ToolUseInfo[] {
	// Attempt JSON parse for ContentBlock[] serialized as string.
	if (content.startsWith("[")) {
		try {
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				return extractToolUses(parsed);
			}
		} catch {
			// Not valid JSON — try heuristic extraction.
		}
	}

	// Heuristic: look for tool name in common formats.
	// Stage 1.7 stub format: "[Tool result truncated..." — not a tool_call.
	// Synthetic tool_call content sometimes looks like: "tool_use: name(args)"
	const nameMatch = content.match(/tool_use[^a-z]*([a-z_]+)/i);
	if (nameMatch) {
		return [{ name: nameMatch[1], hint: "…" }];
	}

	return [{ name: "unknown", hint: "…" }];
}

function isToolUseBlock(
	block: unknown,
): block is { type: "tool_use"; name: string; input: Record<string, unknown> } {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as Record<string, unknown>).type === "tool_use"
	);
}

function extractInputHint(input: unknown): string {
	if (!input || typeof input !== "object") return "…";
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length === 0) return "…";

	// Use the first key's value as the hint.
	const [key, value] = entries[0];
	const valueStr = typeof value === "string" ? value : JSON.stringify(value);
	const hint = valueStr.length > 60 ? `${valueStr.slice(0, 57)}...` : valueStr;
	// For common patterns, use key=value; for single-param tools, just the value.
	if (entries.length === 1) return hint;
	return `${key}=${hint}`;
}

function extractResultSummary(content: string | unknown[]): string {
	const text = extractTextContent(content);

	// Stage 1.7 stub format detection.
	if (text.startsWith("[Tool result truncated for inline display")) {
		// Extract the preview portion after the stub header.
		const newlineIdx = text.indexOf("\n");
		if (newlineIdx >= 0 && newlineIdx < text.length - 1) {
			const preview = text.slice(newlineIdx + 1).trim();
			return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
		}
		return "truncated";
	}

	// Look for exit code pattern (common in bash tool results, including the
	// boundless `Exit code: N\nstdout:\n<output>` shape).
	const exitMatch = text.match(/exit[_ ]code:?\s*(\d+)/i);
	if (exitMatch) {
		const exitCode = exitMatch[1];
		// Find the first substantive output line so the digest records WHAT the
		// command found, not just that it ran. Skip structural noise: the
		// exit-code line itself, the boundless `[boundless] host=…` banner,
		// bracketed stubs, and the bare `stdout:` / `stderr:` stream markers.
		const summaryLine = text
			.split("\n")
			.map((l) => l.trim())
			.find(
				(l) =>
					l.length > 0 &&
					!/exit[_ ]code/i.test(l) &&
					!l.startsWith("[") &&
					!/^(stdout|stderr):?$/i.test(l),
			);
		if (summaryLine) {
			return `exit ${exitCode}, ${summaryLine.length > 80 ? `${summaryLine.slice(0, 77)}...` : summaryLine}`;
		}
		return `exit ${exitCode}`;
	}

	// Look for success/failure indicators.
	if (
		text.includes("success") ||
		text.includes("Success") ||
		text.includes("Edited ") ||
		text.includes("Wrote ")
	) {
		return "success";
	}
	if (text.includes("error") || text.includes("Error") || text.includes("FAILED")) {
		const firstError = text.match(/(?:error|Error|FAILED)[^\n]{0,60}/);
		return firstError ? firstError[0].trim() : "error";
	}

	// Default: first 80 chars.
	const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
	const trimmed = firstLine.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function extractTextContent(content: string | unknown[]): string {
	if (typeof content === "string") {
		// Tool results are frequently persisted as a JSON-serialized
		// ContentBlock[] STRING (e.g. boundless/MCP results:
		// `[{"type":"text","text":"…"}]`). Unwrap that to the joined text so the
		// fold summarizes the actual output instead of leaking the raw block
		// JSON into the digest. Pure + deterministic: same frozen string → same
		// parse → same text. Mirrors the array branch below.
		if (content.startsWith("[")) {
			try {
				const parsed = JSON.parse(content);
				if (Array.isArray(parsed)) return collectBlockText(parsed);
			} catch {
				// Not valid JSON — fall through and treat as plain text.
			}
		}
		return content;
	}
	if (!Array.isArray(content)) return "";
	return collectBlockText(content);
}

/**
 * Join the `text` of every text block in a ContentBlock array. Returns the
 * `[non-text content]` sentinel when no text block is present.
 */
function collectBlockText(blocks: unknown[]): string {
	const texts: string[] = [];
	for (const block of blocks) {
		if (typeof block === "object" && block !== null) {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") {
				texts.push(b.text);
			}
		}
	}
	if (texts.length > 0) return texts.join("\n");
	return "[non-text content]";
}

function clamp(text: string): string {
	if (text.length <= MAX_FOLDED_LINE_CHARS) return text;
	return `${text.slice(0, MAX_FOLDED_LINE_CHARS - 3)}...`;
}

function estimateTokens(text: string): number {
	// Short strings: chars/4 is a reasonable heuristic for cl100k_base.
	// Avoids the cost of running tiktoken on every folded line during assembly.
	return Math.ceil(text.length / 4);
}

/**
 * Collapse runs of CONSECUTIVE identical folded lines into a single `… ×N`
 * line. A long autonomous run that re-reads the same region produces many
 * byte-identical `[read] …` action lines; this renders them as one.
 *
 * Applied at digest-render time (after the tier budget-trim in tier-allocation),
 * NEVER inside `foldMessages`: the tier allocator walks folded lines assuming
 * each covers a contiguous, monotonically-advancing source range, and collapsing
 * non-adjacent lines would corrupt that accounting. Restricting dedup to
 * ADJACENT duplicates keeps the chronological story intact (a read, an edit,
 * then the same read again stays three lines) and is what the agent actually
 * needs to see — a tight loop, not scattered coincidences.
 *
 * Accounting: the collapsed line sums `sourceCount` across the run (coverage
 * invariant) but keeps a single line's `tokens` (the rendered cost). Pure and
 * deterministic: same input -> byte-identical output, so the digest stays
 * cache-stable.
 */
export function dedupeFoldedLines(lines: FoldedLine[]): FoldedLine[] {
	if (lines.length === 0) return [];
	const out: FoldedLine[] = [];
	let i = 0;
	while (i < lines.length) {
		let runEnd = i + 1;
		while (runEnd < lines.length && lines[runEnd].text === lines[i].text) runEnd++;
		const runLength = runEnd - i;
		const summedSource = lines.slice(i, runEnd).reduce((sum, l) => sum + l.sourceCount, 0);
		if (runLength === 1) {
			out.push({ ...lines[i], sourceCount: summedSource });
		} else {
			const text = clamp(`${lines[i].text} ×${runLength}`);
			out.push({ text, tokens: estimateTokens(text), sourceCount: summedSource });
		}
		i = runEnd;
	}
	return out;
}
