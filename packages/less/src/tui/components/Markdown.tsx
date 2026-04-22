import { Box, Text } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import type React from "react";

const HR_WIDTH = 40;

export interface MarkdownProps {
	text: string;
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
 * Renders a single block-level token as an Ink element.
 */
function renderBlock(token: Token, index: number): React.ReactElement | null {
	switch (token.type) {
		case "heading": {
			const t = token as Tokens.Heading;
			const color = t.depth === 1 ? "magenta" : t.depth === 2 ? "blue" : "cyan";
			return (
				<Text key={`block-${index}`} bold color={color}>
					{renderInline(t.tokens, `h${index}-`)}
				</Text>
			);
		}
		case "paragraph": {
			const t = token as Tokens.Paragraph;
			return <Text key={`block-${index}`}>{renderInline(t.tokens, `p${index}-`)}</Text>;
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
					<Text color="green">{t.text}</Text>
				</Box>
			);
		}
		case "list": {
			const t = token as Tokens.List;
			return (
				<Box key={`block-${index}`} flexDirection="column">
					{t.items.map((item, idx) => {
						const marker = t.ordered ? `${(t.start || 1) + idx}.` : "\u2022";
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable tokens
							<Box key={`li-${index}-${idx}`}>
								<Text>{marker} </Text>
								<Text>{renderInline(item.tokens, `li${index}-${idx}-`)}</Text>
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
			// Blockquote contains block-level tokens; render them inline-ish
			const inner = t.tokens
				.filter((bt) => bt.type !== "space")
				.map((bt, bi) => renderBlock(bt, bi))
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
export function Markdown({ text }: MarkdownProps): React.ReactElement {
	if (!text) {
		return <Text>{""}</Text>;
	}

	const tokens = Lexer.lex(text);
	const blocks = tokens
		.map((token, index) => renderBlock(token, index))
		.filter((el): el is React.ReactElement => el !== null);

	if (blocks.length === 0) {
		return <Text>{""}</Text>;
	}

	return <Box flexDirection="column">{blocks}</Box>;
}
