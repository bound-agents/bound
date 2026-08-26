import { Box, Text } from "ink";
import type React from "react";
import { osc8Link } from "../util/osc8";
import { type StyledRun, wrapStyledRuns } from "../util/wrap-styled";
import { HighlightedCodeBlock } from "./HighlightedCode";

const HR_WIDTH = 40;

/**
 * Minimal structural view of a `Bun.markdown.react()` node. We never mount these
 * elements — the tree is used purely as a parse result, so `type` + `props` is
 * the whole contract and importing React's element types would overstate it.
 */
interface MdElement {
	type: unknown;
	props?: Record<string, unknown> & { children?: MdNode };
}
type MdNode = MdElement | string | number | boolean | null | undefined | MdNode[];

/** True for an element node (as opposed to a text leaf, array, or nullish hole). */
function isElement(node: MdNode): node is MdElement {
	return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** Tag name of an element, or "" for a fragment / non-string type. */
function tagOf(node: MdElement): string {
	return typeof node.type === "string" ? node.type : "";
}

/** Children of an element, normalized to an array. */
function childrenOf(node: MdNode): MdNode[] {
	if (!isElement(node)) return [];
	const kids = node.props?.children;
	return Array.isArray(kids) ? kids : kids === undefined ? [] : [kids];
}

/** Element children only, skipping text leaves — the block-sequence view. */
function elementChildren(node: MdNode): MdElement[] {
	return childrenOf(node).filter(isElement);
}

/** Concatenated text content of a subtree, for width math and code bodies. */
function plainText(node: MdNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(plainText).join("");
	return plainText(node.props?.children ?? null);
}

/**
 * Recover which block boundaries the author separated with a blank line.
 *
 * `Bun.markdown.react()` models HTML, where `<h1>` and `<p>` are separate boxes
 * whether or not a blank line sat between them — so unlike marked's `space`
 * tokens, the tree carries no authored-spacing signal. A terminal has no such
 * free separation: the renderer must reproduce the blank row itself, which is
 * what {@link Markdown}'s gap tracking does.
 *
 * Returns one boolean per gap between consecutive top-level blocks, in order.
 * Fence state is tracked so a blank line *inside* a code block is not mistaken
 * for a block separator, and leading/trailing blanks produce no entry at all
 * (they would otherwise strand a blank row above or below the message).
 */
function authoredBlockGaps(src: string): boolean[] {
	const gaps: boolean[] = [];
	let inFence = false;
	let fenceMarker = "";
	let sawBlock = false;
	let pendingBlank = false;
	for (const line of src.split(/\r?\n/)) {
		const trimmed = line.trim();
		const fence = trimmed.match(/^(`{3,}|~{3,})/);
		if (inFence) {
			if (fence && trimmed.startsWith(fenceMarker)) inFence = false;
			continue;
		}
		if (fence) {
			if (sawBlock) {
				gaps.push(pendingBlank);
				pendingBlank = false;
			}
			sawBlock = true;
			inFence = true;
			fenceMarker = fence[1];
			continue;
		}
		if (trimmed === "") {
			if (sawBlock) pendingBlank = true;
			continue;
		}
		if (!sawBlock) {
			sawBlock = true;
			continue;
		}
		if (pendingBlank) {
			gaps.push(true);
			pendingBlank = false;
		}
	}
	return gaps;
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
 * Flatten a `Bun.markdown.react()` inline subtree into styled runs. Produces
 * data rather than Ink elements so the result can be width-wrapped by
 * {@link wrapStyledRuns} before rendering. Nested styles (bold inside a link)
 * merge down the recursion via `base`, and a depth-first walk emits runs in
 * exactly document order — the flat sequence the wrapper's char-offset slicing
 * assumes.
 */
function elementsToRuns(node: MdNode, base: InlineStyle = {}): StyledRun[] {
	if (node === null || node === undefined || typeof node === "boolean") return [];
	if (typeof node === "string") return node.length > 0 ? [{ ...base, text: node }] : [];
	if (typeof node === "number") return [{ ...base, text: String(node) }];
	if (Array.isArray(node)) return node.flatMap((child) => elementsToRuns(child, base));

	const children = node.props?.children ?? null;
	switch (tagOf(node)) {
		case "strong":
		case "b":
			return elementsToRuns(children, { ...base, bold: true });
		case "em":
		case "i":
			return elementsToRuns(children, { ...base, italic: true });
		case "del":
		case "s":
			return elementsToRuns(children, { ...base, strikethrough: true });
		// Inline code renders styled but WITHOUT literal backticks (the color is
		// the affordance; the backticks were just noise). Taken as plain text so a
		// nested element inside code can't smuggle styling in.
		case "code":
			return [{ ...base, color: "yellow", text: plainText(children) }];
		case "a": {
			// Carry the href on the run; renderRun wraps the label in an OSC 8
			// hyperlink escape at draw time. Recursing keeps styled link labels
			// (e.g. **bold** text) styled under the link.
			const href = node.props?.href;
			return elementsToRuns(children, {
				...base,
				color: "cyan",
				underline: true,
				hyperlink: typeof href === "string" ? href : undefined,
			});
		}
		case "br":
			return [{ ...base, text: "\n" }];
		default:
			return elementsToRuns(children, base);
	}
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
	node: MdNode,
	width: number | undefined,
	key: string,
	base: InlineStyle = {},
): React.ReactElement {
	const logicalLines = splitRunsOnNewlines(elementsToRuns(node, base));
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

/** Heading colors by level; h1 is the only one that differs. */
function headingColor(level: number): string {
	return level === 1 ? "magenta" : "cyan";
}

/**
 * Renders a single block-level element as an Ink element. `width`, when set, is
 * the content column budget used to pre-wrap prose (issue #130); it is narrowed
 * for nested blocks (list-item text, blockquote inner) before recursion.
 */
function renderBlock(el: MdElement, index: number, width?: number): React.ReactElement | null {
	const key = `block-${index}`;
	const tag = tagOf(el);
	const children = el.props?.children ?? null;

	if (/^h[1-6]$/.test(tag)) {
		const level = Number(tag.slice(1));
		return renderProse(children, width, key, { bold: true, color: headingColor(level) });
	}

	switch (tag) {
		case "p":
			return renderProse(children, width, key);
		case "pre": {
			// `pre` carries the fence's info string on `language`; the body is text.
			// Trailing newline is trimmed because HighlightedCodeBlock adds its own
			// line breaks and a trailing blank row would pad the fence.
			const lang = typeof el.props?.language === "string" ? el.props.language : undefined;
			const code = plainText(children).replace(/\n$/, "");
			return (
				<Box
					key={key}
					flexDirection="column"
					paddingLeft={2}
					borderStyle="single"
					borderLeft
					borderRight={false}
					borderTop={false}
					borderBottom={false}
					borderColor="gray"
				>
					{lang && (
						<Text dimColor italic>
							{lang}
						</Text>
					)}
					<HighlightedCodeBlock
						code={code}
						lang={lang}
						width={width && width > 0 ? Math.max(10, width - 3) : undefined}
					/>
				</Box>
			);
		}
		case "ul":
		case "ol": {
			const ordered = tag === "ol";
			const startAt = typeof el.props?.start === "number" ? el.props.start : 1;
			const items = elementChildren(el).filter((child) => tagOf(child) === "li");
			return (
				<Box key={key} flexDirection="column">
					{items.map((item, idx) => {
						const marker = ordered ? `${startAt + idx}.` : "\u2022";
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
						// A list item mixes inline content with nested block elements
						// (a sublist, or a `p` in a loose list). Runs of inline nodes
						// coalesce into one prose block so styling survives; block
						// children recurse, which is what keeps a nested list from
						// collapsing to its raw text.
						const parts: React.ReactElement[] = [];
						let inlineRun: MdNode[] = [];
						const flushInline = (): void => {
							if (inlineRun.length === 0) return;
							parts.push(renderProse(inlineRun, itemWidth, `li${index}-${idx}-i${parts.length}`));
							inlineRun = [];
						};
						for (const child of childrenOf(el === item ? el : item)) {
							if (isElement(child) && BLOCK_TAGS.has(tagOf(child))) {
								flushInline();
								const block = renderBlock(child, parts.length, itemWidth);
								if (block) parts.push(block);
							} else {
								inlineRun.push(child);
							}
						}
						flushInline();
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: list items are immutable parse output
							<Box key={`li-${index}-${idx}`}>
								<Box flexShrink={0} width={markerWidth}>
									<Text>{marker}</Text>
								</Box>
								<Box flexDirection="column">{parts}</Box>
							</Box>
						);
					})}
				</Box>
			);
		}
		case "table": {
			// thead/tbody are structural; flatten to rows and treat the first row of
			// a thead as the header. Cell alignment rides on each th/td's `align`.
			const headerCells: MdElement[] = [];
			const bodyRows: MdElement[][] = [];
			for (const section of elementChildren(el)) {
				const sectionTag = tagOf(section);
				for (const row of elementChildren(section)) {
					if (tagOf(row) !== "tr") continue;
					const cells = elementChildren(row);
					if (sectionTag === "thead" && headerCells.length === 0) headerCells.push(...cells);
					else bodyRows.push(cells);
				}
			}
			const colCount = Math.max(headerCells.length, ...bodyRows.map((r) => r.length), 0);
			if (colCount === 0) return null;

			const cellText = (cell: MdElement | undefined): string =>
				cell ? plainText(cell.props?.children ?? null) : "";
			const alignOf = (cell: MdElement | undefined): string | null => {
				const a = cell?.props?.align;
				return typeof a === "string" ? a : null;
			};

			const colWidths: number[] = new Array(colCount).fill(0);
			for (let c = 0; c < colCount; c++) {
				colWidths[c] = Math.max(colWidths[c], cellText(headerCells[c]).length);
				for (const row of bodyRows) {
					colWidths[c] = Math.max(colWidths[c], cellText(row[c]).length);
				}
			}

			// Pad a plain string to a given width respecting alignment
			const pad = (text: string, w: number, align: string | null): string => {
				const diff = w - text.length;
				if (diff <= 0) return text;
				if (align === "right") return " ".repeat(diff) + text;
				if (align === "center") {
					const left = Math.floor(diff / 2);
					return " ".repeat(left) + text + " ".repeat(diff - left);
				}
				return text + " ".repeat(diff);
			};

			const renderRow = (
				cells: MdElement[],
				isHeader: boolean,
				rowKey: string,
			): React.ReactElement => (
				<Box key={rowKey}>
					{Array.from({ length: colCount }, (_, c) => {
						const cell = cells[c];
						const text = cellText(cell);
						const runs = elementsToRuns(
							cell?.props?.children ?? null,
							isHeader ? { bold: true } : {},
						);
						const slack = Math.max(0, colWidths[c] - text.length);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: table cells are immutable parse output
							<Box key={`${rowKey}-c${c}`} width={colWidths[c] + 3}>
								<Text>
									{" "}
									{isHeader ? "" : pad("", slack, alignOf(cell))}
									{runs.map((run, ri) => renderRun(run, `${rowKey}-c${c}-r${ri}`))}
									{isHeader ? " ".repeat(slack) : ""}
								</Text>
							</Box>
						);
					})}
				</Box>
			);

			const separatorStr = colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u2500");
			return (
				<Box key={key} flexDirection="column">
					{headerCells.length > 0 && renderRow(headerCells, true, `th-${index}`)}
					{headerCells.length > 0 && <Text dimColor>{separatorStr}</Text>}
					{bodyRows.map((row, ri) => renderRow(row, false, `tr-${index}-${ri}`))}
				</Box>
			);
		}
		case "blockquote": {
			// Blockquote renders a "\u2502 " prefix (paddingLeft 1 + pipe + space
			// \u2248 3 cols), so its inner blocks wrap at the narrowed budget.
			const innerWidth = width !== undefined ? Math.max(1, width - 3) : undefined;
			const inner = elementChildren(el)
				.map((child, bi) => renderBlock(child, bi, innerWidth))
				.filter((x): x is React.ReactElement => x !== null);
			return (
				<Box key={key} paddingLeft={1}>
					<Text color="gray">{"\u2502"} </Text>
					<Box flexDirection="column">{inner}</Box>
				</Box>
			);
		}
		case "hr":
			return (
				<Text key={key} dimColor>
					{"\u2500".repeat(HR_WIDTH)}
				</Text>
			);
		default: {
			// Unknown block: render its text so content is never silently dropped.
			const runs = elementsToRuns(children);
			if (runs.length === 0) return null;
			return renderProse(children, width, key);
		}
	}
}

/** Tags that are block-level when they appear inside a list item. */
const BLOCK_TAGS = new Set([
	"p",
	"pre",
	"ul",
	"ol",
	"table",
	"blockquote",
	"hr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
]);

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

	// Insert a blank line ONLY between two rendered blocks that the author
	// separated with a blank line. `Bun.markdown.react()` models HTML, where
	// consecutive blocks are separate boxes whether or not a blank line sat
	// between them, so the signal comes from the source via
	// {@link authoredBlockGaps} rather than from the parse tree. Consecutive
	// blanks collapse to a single gap, and leading/trailing blanks produce no
	// entry at all, so they can't strand a stray row above or below the message.
	const root = Bun.markdown.react(text) as unknown as MdNode;
	const topLevel = elementChildren(root);
	const gaps = authoredBlockGaps(text);

	const blocks: React.ReactElement[] = [];
	for (let index = 0; index < topLevel.length; index++) {
		const rendered = renderBlock(topLevel[index], index, width);
		if (rendered === null) continue;
		// gaps[i] describes the boundary BEFORE block i+1, so the gap that
		// precedes this block is gaps[index - 1].
		if (blocks.length > 0 && gaps[index - 1]) {
			blocks.push(<Text key={`gap-${index}`}> </Text>);
		}
		blocks.push(rendered);
	}

	if (blocks.length === 0) {
		return <Text>{""}</Text>;
	}

	return <Box flexDirection="column">{blocks}</Box>;
}
