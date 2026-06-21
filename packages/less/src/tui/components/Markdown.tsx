import { Box, Text } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import type React from "react";
import { type StyledRun, wrapStyledRuns } from "../util/wrap-styled";
import { HighlightedCodeBlock } from "./HighlightedCode";

const HR_WIDTH = 40;

/**
 * Wrap visible text in an OSC 8 hyperlink so the terminal renders it as a real
 * clickable link instead of literal `[label](url)`. Format is
 * `ESC ] 8 ; ; <uri> BEL <label> ESC ] 8 ; ; BEL` — the empty params slot
 * between the two `;` is where a link id would go (omitted; terminals coalesce
 * adjacent same-URI cells without one). Terminals that don't grok OSC 8 ignore
 * the escapes and show the bare label, so this degrades cleanly.
 */
function osc8Link(href: string, label: string): string {
	return `\u001B]8;;${href}\u0007${label}\u001B]8;;\u0007`;
}

/**
 * Split a run sequence into logical lines at authored newlines (embedded `\n`
 * in text tokens, and `br` tokens). Each returned line is a run array with no
 * remaining newlines, preserving every run's style. This is the pre-wrap step
 * that keeps {@link wrapStyledRuns} on its documented newline-free contract:
 * its char-offset slicing assumes wrap-ansi only *inserts* break newlines, so
 * an embedded `\n` would drift the offsets and drop/strand characters. Splitting
 * here also gives a clean seam for double-spacing (a blank visual line is
 * inserted between logical lines, never between soft-wrap continuations).
 */
function splitRunsOnNewlines(runs: StyledRun[]): StyledRun[][] {
	const lines: StyledRun[][] = [[]];
	for (const run of runs) {
		const parts = run.text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) lines.push([]);
			if (parts[i].length > 0) {
				lines[lines.length - 1].push({ ...run, text: parts[i] });
			}
		}
	}
	return lines;
}

export interface MarkdownProps {
	text: string;
	/**
	 * Available content width in columns. When provided, prose blocks
	 * (paragraphs, headings, list items, blockquotes) are pre-wrapped at this
	 * width with leading whitespace elided on continuation lines (issue #130).
	 * When omitted, prose is rendered as a single logical line and Ink wraps it
	 * (which leaves leading whitespace on continuations — the pre-fix behavior,
	 * retained only as a width-less fallback for tests and ad-hoc callers).
	 */
	width?: number;
}

/** Visual style carried by an inline run. Mirrors {@link StyledRun}'s flags. */
type InlineStyle = Omit<StyledRun, "text">;

/**
 * Flatten marked inline tokens into a sequence of styled runs. Parallel to
 * {@link renderInline} but produces data (runs) instead of Ink elements, so the
 * result can be width-wrapped by {@link wrapStyledRuns} before rendering. Nested
 * styles (e.g. bold inside a link) merge down the recursion via `base`.
 */
function inlineTokensToRuns(tokens: Token[], base: InlineStyle = {}): StyledRun[] {
	const runs: StyledRun[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text": {
				const t = token as Tokens.Text;
				if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) {
					runs.push(...inlineTokensToRuns(t.tokens, base));
				} else {
					runs.push({ ...base, text: t.text });
				}
				break;
			}
			case "strong":
				runs.push(...inlineTokensToRuns((token as Tokens.Strong).tokens, { ...base, bold: true }));
				break;
			case "em":
				runs.push(...inlineTokensToRuns((token as Tokens.Em).tokens, { ...base, italic: true }));
				break;
			case "codespan":
				// Inline code renders styled but WITHOUT literal backticks (the color
				// is the affordance; the backticks were just noise).
				runs.push({ ...base, color: "yellow", text: (token as Tokens.Codespan).text });
				break;
			case "link": {
				const t = token as Tokens.Link;
				// Carry the href on the run; renderRun wraps the label in an OSC 8
				// hyperlink escape at draw time. Recurse so styled link labels (e.g.
				// **bold** text) keep their styling under the link.
				runs.push(
					...inlineTokensToRuns(t.tokens, {
						...base,
						color: "cyan",
						underline: true,
						hyperlink: t.href,
					}),
				);
				break;
			}
			case "del":
				runs.push(
					...inlineTokensToRuns((token as Tokens.Del).tokens, { ...base, strikethrough: true }),
				);
				break;
			case "br":
				runs.push({ ...base, text: "\n" });
				break;
			default: {
				if ("text" in token && typeof token.text === "string") {
					runs.push({ ...base, text: token.text });
				} else if ("raw" in token && typeof token.raw === "string") {
					runs.push({ ...base, text: token.raw });
				}
				break;
			}
		}
	}
	return runs;
}

/** Render a single styled run as an Ink `<Text>` element. */
function renderRun(run: StyledRun, key: string): React.ReactElement {
	// OSC 8 escapes are zero-width to string-width@7 / wrap-ansi@9 (Ink's own
	// measurement deps), so wrapping the already-wrapped label here doesn't
	// disturb layout. See wrap-styled.ts for why the escape can't live in `text`.
	const content = run.hyperlink ? osc8Link(run.hyperlink, run.text) : run.text;
	return (
		<Text
			key={key}
			bold={run.bold}
			italic={run.italic}
			underline={run.underline}
			strikethrough={run.strikethrough}
			dimColor={run.dim}
			color={run.color}
		>
			{content}
		</Text>
	);
}

/**
 * Render prose inline tokens as a pre-wrapped `<Text>`. Authored line breaks
 * (embedded `\n`, `br` tokens) split the prose into logical lines first; each
 * is width-wrapped independently and they are rejoined with a BLANK line
 * between them, so separate lines a message author wrote get room to breathe.
 * Soft-wrap continuations stay tight (no blank line) — only authored breaks
 * double-space. Break points are computed at `width` (when > 0) and leading
 * whitespace on continuation lines is elided; each visual line is emitted as
 * its own styled run sequence joined by explicit newlines, so every line fits
 * within `width` and Ink does not re-wrap.
 */
function renderProse(
	tokens: Token[],
	width: number | undefined,
	key: string,
	base: InlineStyle = {},
): React.ReactElement {
	const logicalLines = splitRunsOnNewlines(inlineTokensToRuns(tokens, base));
	const lines: StyledRun[][] = [];
	for (let i = 0; i < logicalLines.length; i++) {
		// Blank visual line between authored lines = the double-spacing.
		if (i > 0) {
			lines.push([]);
		}
		const logical = logicalLines[i];
		const wrapped = width && width > 0 ? wrapStyledRuns(logical, width) : [logical];
		lines.push(...wrapped);
	}
	const children: React.ReactNode[] = [];
	for (let li = 0; li < lines.length; li++) {
		if (li > 0) {
			children.push("\n");
		}
		const line = lines[li];
		for (let ri = 0; ri < line.length; ri++) {
			children.push(renderRun(line[ri], `${li}-${ri}`));
		}
	}
	return <Text key={key}>{children}</Text>;
}

/**
 * Renders inline tokens (text, bold, italic, code, links, etc.) as Ink elements.
 * Inline tokens can nest (e.g. bold inside a link), so this recurses into `tokens`.
 */
function renderInline(tokens: Token[], key = ""): React.ReactElement[] {
	const elements: React.ReactElement[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const k = `${key}${i}`;
		switch (token.type) {
			case "text": {
				const t = token as Tokens.Text;
				// Text tokens can themselves have sub-tokens (e.g. in list items)
				if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) {
					elements.push(...renderInline(t.tokens, `${k}-`));
				} else {
					elements.push(<Text key={k}>{t.text}</Text>);
				}
				break;
			}
			case "strong": {
				const t = token as Tokens.Strong;
				elements.push(
					<Text key={k} bold>
						{renderInline(t.tokens, `${k}-`)}
					</Text>,
				);
				break;
			}
			case "em": {
				const t = token as Tokens.Em;
				elements.push(
					<Text key={k} italic>
						{renderInline(t.tokens, `${k}-`)}
					</Text>,
				);
				break;
			}
			case "codespan": {
				const t = token as Tokens.Codespan;
				// No literal backticks — the color carries the inline-code affordance.
				elements.push(
					<Text key={k} color="yellow">
						{t.text}
					</Text>,
				);
				break;
			}
			case "link": {
				const t = token as Tokens.Link;
				// Real terminal hyperlink (OSC 8) over the label, no trailing `(url)`.
				elements.push(
					<Text key={k} color="cyan" underline>
						{osc8Link(t.href, t.text)}
					</Text>,
				);
				break;
			}
			case "del": {
				const t = token as Tokens.Del;
				elements.push(
					<Text key={k} strikethrough>
						{renderInline(t.tokens, `${k}-`)}
					</Text>,
				);
				break;
			}
			case "br": {
				elements.push(<Text key={k}>{"\n"}</Text>);
				break;
			}
			default: {
				// Fallback: render raw text if available
				if ("text" in token && typeof token.text === "string") {
					elements.push(<Text key={k}>{token.text}</Text>);
				} else if ("raw" in token && typeof token.raw === "string") {
					elements.push(<Text key={k}>{token.raw}</Text>);
				}
				break;
			}
		}
	}
	return elements;
}

/**
 * Renders a single block-level token as an Ink element. `width`, when set, is
 * the content column budget used to pre-wrap prose (issue #130); it is
 * narrowed for nested blocks (list-item text, blockquote inner) before recursion.
 */
function renderBlock(token: Token, index: number, width?: number): React.ReactElement | null {
	switch (token.type) {
		case "heading": {
			const t = token as Tokens.Heading;
			const color = t.depth === 1 ? "magenta" : t.depth === 2 ? "blue" : "cyan";
			return renderProse(t.tokens, width, `block-${index}`, { bold: true, color });
		}
		case "paragraph": {
			const t = token as Tokens.Paragraph;
			return renderProse(t.tokens, width, `block-${index}`);
		}
		case "code": {
			const t = token as Tokens.Code;
			return (
				<Box
					key={`block-${index}`}
					flexDirection="column"
					paddingLeft={2}
					borderStyle="single"
					borderLeft
					borderRight={false}
					borderTop={false}
					borderBottom={false}
					borderColor="gray"
				>
					{t.lang && (
						<Text dimColor italic>
							{t.lang}
						</Text>
					)}
					<HighlightedCodeBlock code={t.text} lang={t.lang} />
				</Box>
			);
		}
		case "list": {
			const t = token as Tokens.List;
			return (
				<Box key={`block-${index}`} flexDirection="column">
					{t.items.map((item, idx) => {
						const marker = t.ordered ? `${(t.start || 1) + idx}.` : "\u2022";
						// The marker sits in its own fixed-width column (marker length
						// plus a one-column gutter), so the item's wrap budget is the
						// content width minus that prefix. The marker column reserves
						// the gutter via `width` rather than a trailing space in the
						// marker Text: Ink trims trailing whitespace from a Text node
						// that is a flex-row sibling, which would butt the content
						// against the marker (`1.content`) and misalign wrapped
						// continuation lines by one column (issue #142).
						const markerWidth = marker.length + 1;
						const itemWidth = width !== undefined ? Math.max(1, width - markerWidth) : undefined;
						const itemKey = `li${index}-${idx}`;
						// A list item's children are a mix of inline content (`text`
						// in tight lists, `paragraph` in loose lists) and nested
						// block tokens (`list` for sublists). Dispatch each child by
						// type: `text` renders through renderProse so inline styling
						// survives; everything else routes through renderBlock, which
						// already handles `paragraph` → prose and recurses for nested
						// `list`. Flattening every child through renderProse (as the
						// pre-#142-followup code did) dropped nested lists to their raw
						// text default (`now1.`) and stripped inline styling from
						// loose-list paragraphs.
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable tokens
							<Box key={`li-${index}-${idx}`}>
								<Box flexShrink={0} width={markerWidth}>
									<Text>{marker}</Text>
								</Box>
								<Box flexDirection="column">
									{item.tokens.map((child, ci) => {
										if (child.type === "space") return null;
										if (child.type === "text") {
											const tt = child as Tokens.Text;
											const inline = tt.tokens && tt.tokens.length > 0 ? tt.tokens : [child];
											return renderProse(inline, itemWidth, `${itemKey}-c${ci}`);
										}
										return renderBlock(child, ci, itemWidth);
									})}
								</Box>
							</Box>
						);
					})}
				</Box>
			);
		}
		case "table": {
			const t = token as Tokens.Table;
			const colCount = t.header.length;

			// Compute column widths from plain text of header + all rows
			const colWidths: number[] = new Array(colCount).fill(0);
			for (let c = 0; c < colCount; c++) {
				colWidths[c] = Math.max(colWidths[c], t.header[c].text.length);
			}
			for (const row of t.rows) {
				for (let c = 0; c < colCount; c++) {
					if (row[c]) {
						colWidths[c] = Math.max(colWidths[c], row[c].text.length);
					}
				}
			}

			// Pad a plain string to a given width respecting alignment
			const pad = (text: string, width: number, align: string | null): string => {
				const diff = width - text.length;
				if (diff <= 0) return text;
				if (align === "right") return " ".repeat(diff) + text;
				if (align === "center") {
					const left = Math.floor(diff / 2);
					return " ".repeat(left) + text + " ".repeat(diff - left);
				}
				return text + " ".repeat(diff);
			};

			// Render a row of cells (header or data)
			const renderRow = (
				cells: Tokens.TableCell[],
				isHeader: boolean,
				rowKey: string,
			): React.ReactElement => (
				<Box key={rowKey}>
					{cells.map((cell, c) => {
						const paddedWidth = colWidths[c] + 2; // 1 space padding each side
						const inner = renderInline(cell.tokens, `${rowKey}-c${c}-`);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: table cells are immutable tokens
							<Box key={`${rowKey}-c${c}`} width={paddedWidth + 1}>
								{isHeader ? (
									<Text bold>
										{" "}
										{inner}
										{" ".repeat(Math.max(0, colWidths[c] - cell.text.length))}
									</Text>
								) : (
									<Text>
										{" "}
										{pad("", Math.max(0, colWidths[c] - cell.text.length), cell.align)}
										{inner}
									</Text>
								)}
							</Box>
						);
					})}
				</Box>
			);

			// Separator line
			const separatorStr = colWidths.map((w) => "─".repeat(w + 2)).join("─");

			return (
				<Box key={`block-${index}`} flexDirection="column">
					{renderRow(t.header, true, `th-${index}`)}
					<Text dimColor>{separatorStr}</Text>
					{t.rows.map((row, ri) => renderRow(row, false, `tr-${index}-${ri}`))}
				</Box>
			);
		}
		case "blockquote": {
			const t = token as Tokens.Blockquote;
			// Blockquote renders a "│ " prefix (paddingLeft 1 + pipe + space ≈ 3
			// cols), so its inner blocks wrap at the narrowed budget.
			const innerWidth = width !== undefined ? Math.max(1, width - 3) : undefined;
			const inner = t.tokens
				.filter((bt) => bt.type !== "space")
				.map((bt, bi) => renderBlock(bt, bi, innerWidth))
				.filter(Boolean);
			return (
				<Box key={`block-${index}`} paddingLeft={1}>
					<Text color="gray">{"\u2502"} </Text>
					<Box flexDirection="column">{inner}</Box>
				</Box>
			);
		}
		case "hr": {
			return (
				<Text key={`block-${index}`} dimColor>
					{"\u2500".repeat(HR_WIDTH)}
				</Text>
			);
		}
		case "space": {
			return null;
		}
		default: {
			// Fallback: render raw text
			if ("raw" in token && typeof token.raw === "string") {
				return <Text key={`block-${index}`}>{token.raw}</Text>;
			}
			return null;
		}
	}
}

/**
 * Parses a markdown string and renders it as styled Ink components.
 *
 * Supports: headings, paragraphs, bold, italic, inline code, fenced code blocks,
 * ordered/unordered lists, blockquotes, links, strikethrough, and horizontal rules.
 */
export function Markdown({ text, width }: MarkdownProps): React.ReactElement {
	if (!text) {
		return <Text>{""}</Text>;
	}

	const tokens = Lexer.lex(text);
	const blocks = tokens
		.map((token, index) => renderBlock(token, index, width))
		.filter((el): el is React.ReactElement => el !== null);

	if (blocks.length === 0) {
		return <Text>{""}</Text>;
	}

	return <Box flexDirection="column">{blocks}</Box>;
}
