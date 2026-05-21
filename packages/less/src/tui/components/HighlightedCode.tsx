import { type ThemedToken, highlightToTokens, normalizeLang } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";

/**
 * Per-token Ink rendering for shiki-tokenized output.
 *
 * `HighlightedLine` renders a single line; `HighlightedCodeBlock` renders
 * a multi-line code block. Both consume the shared shiki singleton from
 * `@bound/shared` (warmed at TUI boot in boundless.tsx) so syntax colors
 * match the web UI.
 *
 * Color override: callers (e.g. EditDiffBody) can pass `color` to force
 * every token to render with a single color — this is how diff add/remove
 * styling layers on top of syntax highlighting (diff wins, per Kara's spec).
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
	 * Used by diff renderers to paint add/remove lines red/green while
	 * still inheriting the line layout from the shared tokenizer.
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
	if (line.length === 0) {
		// Preserve blank-line layout — shiki returns no tokens for "" so
		// we'd render nothing and collapse the row otherwise.
		return <Text> </Text>;
	}
	const lines = highlightToTokens(line, normalizeLang(lang));
	const tokens = lines[0] ?? [];
	if (tokens.length === 0) {
		return (
			<Text color={color} dimColor={dim}>
				{line}
			</Text>
		);
	}
	return <Text dimColor={dim}>{renderTokens(tokens, color, "t")}</Text>;
}

export interface HighlightedCodeBlockProps {
	code: string;
	lang?: string;
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
}: HighlightedCodeBlockProps): React.ReactElement {
	const lines = highlightToTokens(code, normalizeLang(lang));
	return (
		<Box flexDirection="column">
			{lines.map((tokens, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: tokens are stable per render
				<Text key={i}>{renderTokens(tokens, undefined, `l${i}`)}</Text>
			))}
		</Box>
	);
}
