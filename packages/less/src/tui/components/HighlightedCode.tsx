import { type ThemedToken, highlightToTokens, normalizeLang } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { stripTerminalControlSequences } from "../util/terminal-control";

/**
 * Per-token Ink rendering for shiki-tokenized output.
 *
 * `HighlightedLine` renders a single line; `HighlightedCodeBlock` renders
 * a multi-line code block. Both consume the shared shiki singleton from
 * `@bound/shared` (warmed at TUI boot in boundless.tsx) so syntax colors
 * match the web UI.
 *
 * Color override remains available for callers that need a uniform foreground.
 * Diff renderers do not use it: per #231, the gutter carries add/remove
 * semantics while source content keeps its per-token syntax colors.
 *
 * Wrapping (#239): a highlighted line must be tokenized WHOLE and only then
 * sliced into visual rows — wrapping the text first and highlighting each
 * fragment re-runs the grammar from a mid-line state and breaks the colors at
 * every wrap point, and leaving the wrap to Ink splits the nested styled
 * spans arbitrarily. `wrapTokenRow` is the shared slicer; `HighlightedWrappedLine`
 * and `HighlightedCodeBlock`'s `width` prop are the consumers.
 */

/** Map a file path to a lang tag suitable for shiki / normalizeLang. */
export function langFromPath(filePath: string | null | undefined): string | undefined {
	if (!filePath) return undefined;
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return undefined;
	const ext = filePath.slice(dot + 1).toLowerCase();
	// Hand off to normalizeLang for aliasing (js → javascript, py → python, etc.).
	return ext;
}

/** Italic bit in shiki's fontStyle bitfield. */
const FONT_STYLE_ITALIC = 1;
/** Bold bit in shiki's fontStyle bitfield. */
const FONT_STYLE_BOLD = 2;

/** Render a sequence of themed tokens as Ink <Text> children. */
function renderTokens(
	tokens: readonly ThemedToken[],
	overrideColor: string | undefined,
	keyPrefix: string,
): React.ReactNode[] {
	return tokens.map((tok, i) => {
		const italic = !!(tok.fontStyle && tok.fontStyle & FONT_STYLE_ITALIC);
		const bold = !!(tok.fontStyle && tok.fontStyle & FONT_STYLE_BOLD);
		return (
			<Text
				// biome-ignore lint/suspicious/noArrayIndexKey: tokens are immutable per render and prefix scopes the key per call site
				key={`${keyPrefix}-${i}`}
				color={overrideColor ?? tok.color}
				italic={italic}
				bold={bold}
			>
				{tok.content}
			</Text>
		);
	});
}

export interface HighlightedLineProps {
	line: string;
	lang?: string;
	/**
	 * Force every token to this color (overrides per-token shiki colors).
	 * Diff renderers intentionally leave this unset so syntax colors survive.
	 */
	color?: string;
	/** Apply Ink's dimColor on top of token colors. */
	dim?: boolean;
}

/**
 * Render a single line of source as syntax-highlighted Ink text.
 *
 * If shiki isn't ready (shouldn't happen post-prewarm) or the line
 * is empty, falls back to a plain `<Text>` so callers can drop this
 * in anywhere a `<Text>` was previously used.
 */
export function HighlightedLine({
	line,
	lang,
	color,
	dim,
}: HighlightedLineProps): React.ReactElement {
	const safeLine = stripTerminalControlSequences(line);
	if (safeLine.length === 0) {
		// Preserve blank-line layout — shiki returns no tokens for "" so
		// we'd render nothing and collapse the row otherwise.
		return <Text> </Text>;
	}
	const lines = highlightToTokens(safeLine, normalizeLang(lang));
	const tokens = lines[0] ?? [];
	if (tokens.length === 0) {
		return (
			<Text color={color} dimColor={dim}>
				{safeLine}
			</Text>
		);
	}
	return <Text dimColor={dim}>{renderTokens(tokens, color, "t")}</Text>;
}

/**
 * Slice one highlighted token row into visual rows of at most `width`
 * codepoints, preserving each token's style on both sides of a split (#239).
 * Codepoint slicing mirrors wrapLineAtWidth's hard-wrap semantics, so token
 * rows and plain rows produce identical row counts for the same content —
 * which is what lets scroll math run on plain text while rendering tokens.
 */
export function wrapTokenRow(tokens: readonly ThemedToken[], width: number): ThemedToken[][] {
	if (width <= 0) return [Array.from(tokens)];
	const rows: ThemedToken[][] = [];
	let current: ThemedToken[] = [];
	let used = 0;
	for (const tok of tokens) {
		// Spread iterates by codepoint so surrogate pairs never split.
		let rest = [...tok.content];
		while (rest.length > 0) {
			const room = width - used;
			if (room <= 0) {
				rows.push(current);
				current = [];
				used = 0;
				continue;
			}
			const take = rest.slice(0, room);
			current.push({ ...tok, content: take.join("") });
			used += take.length;
			rest = rest.slice(room);
		}
	}
	rows.push(current);
	return rows;
}

/**
 * Highlight one LOGICAL line and slice its tokens into visual rows of at
 * most `width` codepoints. The `[0] ?? []` is safe: the input carries no
 * newline, so shiki returns at most one token row.
 */
export function highlightLineToRows(
	line: string,
	lang: string | undefined,
	width: number,
): ThemedToken[][] {
	const safeLine = stripTerminalControlSequences(line);
	const lines = highlightToTokens(safeLine, normalizeLang(lang));
	return wrapTokenRow(lines[0] ?? [], width);
}

/** Render one pre-sliced token row as inline Ink text (blank row = one space). */
export function TokenSpan({
	tokens,
	dim,
	color,
}: {
	tokens: readonly ThemedToken[];
	dim?: boolean;
	color?: string;
}): React.ReactElement {
	if (tokens.length === 0) return <Text> </Text>;
	return <Text dimColor={dim}>{renderTokens(tokens, color, "t")}</Text>;
}

export interface HighlightedWrappedLineProps {
	line: string;
	lang?: string;
	/**
	 * Width budget for the CODE portion of each visual row (prefix excluded).
	 * Undefined keeps the legacy single-Text rendering (Ink wraps).
	 */
	width?: number;
	/** Rendered before the first row's tokens (gutter, diff marker, …). */
	firstPrefix?: React.ReactNode;
	/** Plain indent string rendered before each continuation row. */
	contIndent?: string;
	dim?: boolean;
	color?: string;
}

/**
 * A prefixed, token-aware wrapped source line (#239): the whole line is
 * tokenized once, rows are sliced at `width`, the first row carries the
 * caller's prefix and continuations carry a plain indent — so wraps never
 * break tokenization, never lose the gutter, and never escape a StripeBox.
 */
export function HighlightedWrappedLine({
	line,
	lang,
	width,
	firstPrefix,
	contIndent = "",
	dim,
	color,
}: HighlightedWrappedLineProps): React.ReactElement {
	const safeLine = stripTerminalControlSequences(line);
	if (width === undefined || width <= 0) {
		return (
			<Text dimColor={dim}>
				{firstPrefix}
				<HighlightedLine line={safeLine} lang={lang} color={color} dim={dim} />
			</Text>
		);
	}
	const rows = wrapTokenRow(highlightToTokens(safeLine, normalizeLang(lang))[0] ?? [], width);
	return (
		<Box flexDirection="column">
			{rows.map((rowTokens, ri) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are immutable per render
				<Text key={ri} dimColor={dim}>
					{ri === 0 ? firstPrefix : contIndent}
					{rowTokens.length === 0 ? " " : renderTokens(rowTokens, color, `r${ri}`)}
				</Text>
			))}
		</Box>
	);
}

export interface HighlightedCodeBlockProps {
	code: string;
	lang?: string;
	/**
	 * Content-column budget (#239). When set, each source line's token row is
	 * hard-sliced at this width so Ink never wraps mid-token; when absent,
	 * legacy Ink wrapping applies.
	 */
	width?: number;
}

/**
 * Render a multi-line code block as syntax-highlighted Ink text.
 *
 * Used by Markdown.tsx for fenced code blocks. Each line is its own
 * <Text> inside a column-flex Box so wrapping behaves and Ink
 * doesn't collapse trailing whitespace across lines.
 */
export function HighlightedCodeBlock({
	code,
	lang,
	width,
}: HighlightedCodeBlockProps): React.ReactElement {
	const lines = highlightToTokens(stripTerminalControlSequences(code), normalizeLang(lang));
	const rows = width && width > 0 ? lines.flatMap((tokens) => wrapTokenRow(tokens, width)) : lines;
	return (
		<Box flexDirection="column">
			{rows.map((tokens, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: tokens are stable per render
				<Text key={i}>{tokens.length === 0 ? " " : renderTokens(tokens, undefined, `l${i}`)}</Text>
			))}
		</Box>
	);
}
