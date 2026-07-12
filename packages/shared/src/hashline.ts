/**
 * Hashline — stable file read/edit anchors via per-line content hashes.
 *
 * Port of the hashline harness strategy (bound issue #16):
 * - antirez, "Vibe coding at the line level" — https://antirez.com/news/166
 * - Can Balioglu, "The Harness Problem" — https://blog.can.ac/2026/02/12/the-harness-problem/
 * - Reference implementation: https://github.com/kebbbnnn/hashline
 *
 * Reads render every line as `LINE:HASH|content`. Edits reference those
 * anchors (`start`/`end` of an inclusive line range) instead of reproducing
 * file content, so the model doesn't need the exact prior text in context —
 * it only needs the anchor tags from any earlier read. If the file shifted
 * since that read (lines inserted/deleted above the target), anchors are
 * recovered by hash match with proximity to the stale line-number hint.
 *
 * Divergence from the reference: the hash is FNV-1a 32-bit truncated to
 * 4 hex chars rather than MD5. This package is bundled into the web SPA,
 * so `node:crypto` is off the table; the anchor space (65k) and the
 * trimmed-content / reserved-empty-hash semantics are identical.
 */

/** Reserved hash for empty and whitespace-only lines (matches the reference). */
export const EMPTY_LINE_HASH = "    ";

/** A parsed edit anchor: optional 1-based line hint plus 4-char content hash. */
export interface HashlineAnchor {
	line: number | undefined;
	hash: string;
}

/** One edit: replace the inclusive line range [start..end] with `content`. */
export interface HashlineEdit {
	/** Anchor for the first line of the range, e.g. "12:a3f1". */
	start: string;
	/** Anchor for the last line of the range (same as start for one line). */
	end: string;
	/** Replacement text; "" deletes the range. Multi-line via "\n". */
	content: string;
}

/** Where an edit's replacement landed in the NEW content (1-based, ascending). */
export interface HashlineEditRegion {
	startLine: number;
	/** Number of replacement lines; 0 for a pure deletion. */
	lineCount: number;
}

export type HashlineApplyResult =
	| { ok: true; content: string; regions: HashlineEditRegion[] }
	| { ok: false; error: string };

export type AnchorResolution = { ok: true; index: number } | { ok: false; error: string };

const HASH_RE = /^[0-9a-f]{4}$/;

function isValidHash(hash: string): boolean {
	return hash === EMPTY_LINE_HASH || HASH_RE.test(hash);
}

/**
 * Deterministic 4-hex-char hash of a line's trimmed content.
 * Whitespace-only lines get the reserved `EMPTY_LINE_HASH`.
 */
export function computeLineHash(line: string): string {
	const stripped = line.trim();
	if (stripped.length === 0) return EMPTY_LINE_HASH;

	// FNV-1a 32-bit over UTF-16 code units, truncated to 4 hex chars.
	let h = 0x811c9dc5;
	for (let i = 0; i < stripped.length; i++) {
		h ^= stripped.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

/** Split file content into lines, treating a trailing newline as a terminator
 * (no phantom empty last line) and an empty file as zero lines. */
function splitLines(content: string): string[] {
	if (content === "") return [];
	const body = content.endsWith("\n") ? content.slice(0, -1) : content;
	return body.split("\n");
}

/**
 * Render file content in hashline read format: `LINE:HASH|content` per line,
 * 1-based numbering. `offset`/`limit` window the output while keeping true
 * line numbers.
 */
export function formatWithHashes(content: string, offset = 1, limit?: number): string {
	const lines = splitLines(content);
	const start = Math.max(0, offset - 1);
	const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);

	const out: string[] = [];
	for (let i = start; i < end; i++) {
		out.push(`${i + 1}:${computeLineHash(lines[i])}|${lines[i]}`);
	}
	return out.join("\n");
}

/**
 * Parse an anchor string. Accepts `LINE:HASH` (line hint + hash) or a bare
 * `HASH` (no hint). Returns null on anything malformed.
 */
export function parseAnchor(anchor: string): HashlineAnchor | null {
	if (anchor.length === 0) return null;

	const colon = anchor.indexOf(":");
	if (colon === -1) {
		return isValidHash(anchor) ? { line: undefined, hash: anchor } : null;
	}

	const linePart = anchor.slice(0, colon);
	const hashPart = anchor.slice(colon + 1);
	if (!/^\d+$/.test(linePart)) return null;
	if (!isValidHash(hashPart)) return null;

	const line = Number.parseInt(linePart, 10);
	if (line < 1) return null;
	return { line, hash: hashPart };
}

/**
 * Resolve an anchor against the current lines of a file.
 *
 * All lines whose content hash matches are candidates. A unique match wins
 * outright. Multiple matches resolve by proximity to the (possibly stale)
 * line hint — this is what makes anchors survive inserts/deletes above the
 * target. With no hint, the first match wins.
 */
export function resolveAnchor(lines: string[], anchor: HashlineAnchor): AnchorResolution {
	const matches: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (computeLineHash(lines[i]) === anchor.hash) matches.push(i);
	}

	if (matches.length === 0) {
		return {
			ok: false,
			error: `hash "${anchor.hash}" not found — the file may have changed; re-read to get fresh anchors`,
		};
	}
	if (matches.length === 1) return { ok: true, index: matches[0] };

	if (anchor.line === undefined) return { ok: true, index: matches[0] };

	const targetIdx = anchor.line - 1;
	let best = matches[0];
	for (const m of matches) {
		if (Math.abs(m - targetIdx) < Math.abs(best - targetIdx)) best = m;
	}
	return { ok: true, index: best };
}

/**
 * Apply a batch of hashline edits atomically: every anchor is resolved and
 * every range validated against the ORIGINAL content before anything is
 * rewritten. Any failure rejects the whole batch.
 */
export function applyHashlineEdits(
	content: string,
	edits: readonly HashlineEdit[],
): HashlineApplyResult {
	const hadTrailingNewline = content.endsWith("\n");
	const lines = splitLines(content);

	// Phase 1: resolve + validate all edits against the pre-edit content.
	const resolved: Array<{ editIdx: number; startIdx: number; endIdx: number; content: string }> =
		[];
	for (let ei = 0; ei < edits.length; ei++) {
		const edit = edits[ei];

		const startAnchor = parseAnchor(edit.start);
		if (startAnchor === null) {
			return {
				ok: false,
				error: `edit ${ei + 1}: malformed start anchor "${edit.start}" (expected LINE:HASH)`,
			};
		}
		const endAnchor = parseAnchor(edit.end);
		if (endAnchor === null) {
			return {
				ok: false,
				error: `edit ${ei + 1}: malformed end anchor "${edit.end}" (expected LINE:HASH)`,
			};
		}

		const start = resolveAnchor(lines, startAnchor);
		if (!start.ok) {
			return { ok: false, error: `edit ${ei + 1}: start anchor "${edit.start}": ${start.error}` };
		}
		const end = resolveAnchor(lines, endAnchor);
		if (!end.ok) {
			return { ok: false, error: `edit ${ei + 1}: end anchor "${edit.end}": ${end.error}` };
		}

		if (end.index < start.index) {
			return {
				ok: false,
				error: `edit ${ei + 1}: end anchor (line ${end.index + 1}) resolves before start anchor (line ${start.index + 1})`,
			};
		}

		resolved.push({
			editIdx: ei + 1,
			startIdx: start.index,
			endIdx: end.index,
			content: edit.content,
		});
	}

	// Phase 2: overlap check across the batch.
	const byStart = [...resolved].sort((a, b) => a.startIdx - b.startIdx);
	for (let i = 1; i < byStart.length; i++) {
		const prev = byStart[i - 1];
		const curr = byStart[i];
		if (curr.startIdx <= prev.endIdx) {
			return {
				ok: false,
				error: `edits ${prev.editIdx} and ${curr.editIdx} overlap in the target line ranges`,
			};
		}
	}

	// Phase 3: apply bottom-up so earlier indices stay valid.
	const out = [...lines];
	for (let i = byStart.length - 1; i >= 0; i--) {
		const { startIdx, endIdx, content: replacement } = byStart[i];
		const newLines = replacement === "" ? [] : replacement.split("\n");
		out.splice(startIdx, endIdx - startIdx + 1, ...newLines);
	}

	// Post-edit regions (ascending): where each replacement landed in the new
	// content, accounting for line-count drift from edits above it.
	const regions: HashlineEditRegion[] = [];
	let delta = 0;
	for (const { startIdx, endIdx, content: replacement } of byStart) {
		const lineCount = replacement === "" ? 0 : replacement.split("\n").length;
		regions.push({ startLine: startIdx + 1 + delta, lineCount });
		delta += lineCount - (endIdx - startIdx + 1);
	}

	const joined = out.join("\n");
	return { ok: true, content: hadTrailingNewline ? `${joined}\n` : joined, regions };
}
