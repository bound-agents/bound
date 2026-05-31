import { Box, Text } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import type React from "react";
import { type StyledRun, wrapStyledRuns } from "../util/wrap-styled";
import { HighlightedCodeBlock } from "./HighlightedCode";

const HR_WIDTH = 40;

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
				runs.push({ ...base, color: "yellow", text: `\`${(token as Tokens.Codespan).text}\`` });
				break;
			case "link": {
				const t = token as Tokens.Link;
				runs.push({ ...base, color: "cyan", underline: true, text: t.text });
				runs.push({ ...base, dim: true, text: ` (${t.href})` });
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
			{run.text}
		</Text>
	);
}

/**
 * Render prose inline tokens as a pre-wrapped `<Text>`. Break points are
 * computed at `width` (when > 0) and leading whitespace on continuation lines
 * is elided; each visual line is emitted as its own styled run sequence joined
 * by explicit newlines, so every line fits within `width` and Ink does not
 * re-wrap (and so cannot reintroduce leading-whitespace continuations).
 */
function renderProse(
	tokens: Token[],
	width: number | undefined,
	key: string,
	base: InlineStyle = {},
): React.ReactElement {
	const runs = inlineTokensToRuns(tokens, base);
	const lines = width && width > 0 ? wrapStyledRuns(runs, width) : [runs];
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
				elements.push(
					<Text key={k} color="yellow">
						{"`"}
						{t.text}
						{"`"}
					</Text>,
				);
				break;
			}
			case "link": {
				const t = token as Tokens.Link;
				elements.push(
					<Text key={k}>
						<Text color="cyan" underline>
							{t.text}
						</Text>
						<Text dimColor> ({t.href})</Text>
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
						// The marker Text renders `${marker} ` (marker + one space)
						// alongside the item text, so the item's wrap budget is the
						// content width minus that prefix.
						const itemWidth =
							width !== undefined ? Math.max(1, width - (marker.length + 1)) : undefined;
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable tokens
							<Box key={`li-${index}-${idx}`}>
								<Text>{marker} </Text>
								{renderProse(item.tokens, itemWidth, `li${index}-${idx}`)}
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
