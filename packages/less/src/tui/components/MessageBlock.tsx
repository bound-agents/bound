import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { tildifyPath, tildifyText } from "../util/path";
import { wrapLinesAtWidth } from "../util/wrap";
import { HighlightedLine, langFromPath } from "./HighlightedCode";
import { Markdown } from "./Markdown";
import { computeLineDiff, hunkDiff } from "./lineDiff";

const TOOL_RESULT_MAX_LINES = 5;
/** Hard cap on rendered diff entries (after hunking) per edit call. */
const EDIT_DIFF_MAX_LINES = 24;
/** Lines of unchanged context to keep on either side of a change run. */
const EDIT_DIFF_CONTEXT = 3;
/** Preview lines shown under a `boundless_write` call. */
const WRITE_PREVIEW_MAX_LINES = 8;

/** Strip the "boundless_" prefix from local tool names for cleaner display. */
function displayToolName(name: string): string {
	return name.startsWith("boundless_") ? name.slice("boundless_".length) : name;
}

/** Summarize tool arguments for display, showing the most relevant arg value. */
function summarizeToolArgs(toolName: string, input: Record<string, unknown>): string {
	// For common tools, show the primary argument
	if (toolName.endsWith("_bash") && typeof input.command === "string") {
		const cmd = input.command;
		return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
	}
	if (
		(toolName.endsWith("_read") || toolName.endsWith("_write") || toolName.endsWith("_edit")) &&
		typeof input.file_path === "string"
	) {
		return tildifyPath(input.file_path);
	}
	// For MCP/other tools, show a compact key=value summary
	const entries = Object.entries(input);
	if (entries.length === 0) return "";
	const parts = entries.slice(0, 3).map(([k, v]) => {
		const str = typeof v === "string" ? v : JSON.stringify(v);
		const truncated = str.length > 40 ? `${str.slice(0, 37)}...` : str;
		return `${k}=${truncated}`;
	});
	return parts.join(" ");
}

/**
 * Render a unified-diff body for a `boundless_edit` tool call, using the
 * call's `old_string`/`new_string` args. Lines get syntax-highlighted via
 * the shared shiki singleton; on add/remove lines the diff color (green/red)
 * overrides token colors so the diff signal stays unambiguous.
 * Long unchanged stretches between changes are collapsed via `hunkDiff`,
 * and the whole rendering is hard-capped at EDIT_DIFF_MAX_LINES entries.
 */
function EditDiffBody({
	oldString,
	newString,
	filePath,
}: {
	oldString: string;
	newString: string;
	filePath?: string | null;
}): React.ReactElement | null {
	const diff = computeLineDiff(oldString, newString);
	const hunked = hunkDiff(diff, EDIT_DIFF_CONTEXT);
	if (hunked.length === 0) {
		return null;
	}

	const truncated = hunked.length > EDIT_DIFF_MAX_LINES;
	const display = truncated ? hunked.slice(0, EDIT_DIFF_MAX_LINES) : hunked;
	const lang = langFromPath(filePath);

	return (
		<Box flexDirection="column" paddingLeft={2}>
			{display.map((entry, idx) => {
				if (entry.kind === "ellipsis") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff entries are immutable per render
						<Text key={idx} dimColor>
							⋯ {entry.count} unchanged {entry.count === 1 ? "line" : "lines"}
						</Text>
					);
				}
				if (entry.kind === "remove") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff entries are immutable per render
						<Text key={idx}>
							<Text color="red">- </Text>
							<HighlightedLine line={entry.text} lang={lang} color="red" />
						</Text>
					);
				}
				if (entry.kind === "add") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff entries are immutable per render
						<Text key={idx}>
							<Text color="green">+ </Text>
							<HighlightedLine line={entry.text} lang={lang} color="green" />
						</Text>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff entries are immutable per render
					<Text key={idx}>
						<Text dimColor>{"  "}</Text>
						<HighlightedLine line={entry.text} lang={lang} dim />
					</Text>
				);
			})}
			{truncated && (
				<Text dimColor>
					⋯ {hunked.length - EDIT_DIFF_MAX_LINES} more diff{" "}
					{hunked.length - EDIT_DIFF_MAX_LINES === 1 ? "entry" : "entries"}
				</Text>
			)}
		</Box>
	);
}

/**
 * Render a content preview for a `boundless_write` tool call. Since write
 * replaces (or creates) a file's full contents, every line is conceptually
 * "added" — we show the first N lines with a green `+ ` prefix and let
 * shiki tokens carry the foreground colors so the code stays readable.
 * (Departing from strict diff semantics here on purpose: green prefix as
 * a visual cue, syntax colors on the content itself.)
 */
function WritePreviewBody({
	content,
	filePath,
}: {
	content: string;
	filePath?: string | null;
}): React.ReactElement | null {
	if (content.length === 0) {
		return null;
	}
	const lines = content.split("\n");
	const truncated = lines.length > WRITE_PREVIEW_MAX_LINES;
	const display = truncated ? lines.slice(0, WRITE_PREVIEW_MAX_LINES) : lines;
	const lang = langFromPath(filePath);
	return (
		<Box flexDirection="column" paddingLeft={2}>
			{display.map((line, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: preview lines are immutable per render
				<Text key={idx}>
					<Text color="green">+ </Text>
					<HighlightedLine line={line} lang={lang} />
				</Text>
			))}
			{truncated && (
				<Text dimColor>
					⋯ {lines.length - WRITE_PREVIEW_MAX_LINES} more{" "}
					{lines.length - WRITE_PREVIEW_MAX_LINES === 1 ? "line" : "lines"}
				</Text>
			)}
		</Box>
	);
}

/**
 * Render a single tool_use block. Most tools collapse to a single
 * `⏵ name args` row; `boundless_edit` and `boundless_write` get a richer
 * header + body rendering so the actual change content is visible inline
 * with the call (the tool result alone doesn't carry the diff).
 */
function ToolCallRow({
	block,
}: {
	block: { name: string; input: Record<string, unknown> };
}): React.ReactElement {
	const isRemote = !block.name.startsWith("boundless_");
	const name = displayToolName(block.name);
	const filePath = typeof block.input.file_path === "string" ? block.input.file_path : null;
	// `displayPath` is the tildified version for header rendering; we keep the
	// original `filePath` for EditDiffBody / WritePreviewBody, which use it for
	// syntax-highlighting language detection.
	const displayPath = filePath ? tildifyPath(filePath) : null;

	// boundless_edit: header + colored unified diff
	if (block.name === "boundless_edit" && filePath) {
		const oldString = typeof block.input.old_string === "string" ? block.input.old_string : "";
		const newString = typeof block.input.new_string === "string" ? block.input.new_string : "";
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="cyan">⏵ </Text>
					<Text color="cyan" bold>
						{name}
					</Text>
					<Text dimColor> {displayPath}</Text>
				</Text>
				<EditDiffBody oldString={oldString} newString={newString} filePath={filePath} />
			</Box>
		);
	}

	// boundless_write: header + first-N-lines content preview as adds
	if (block.name === "boundless_write" && filePath) {
		const content = typeof block.input.content === "string" ? block.input.content : "";
		const lineCount = content.length === 0 ? 0 : content.split("\n").length;
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="cyan">⏵ </Text>
					<Text color="cyan" bold>
						{name}
					</Text>
					<Text dimColor>
						{" "}
						{displayPath} · {lineCount} {lineCount === 1 ? "line" : "lines"}
					</Text>
				</Text>
				<WritePreviewBody content={content} filePath={filePath} />
			</Box>
		);
	}

	// Generic single-line rendering for everything else.
	const argSummary = summarizeToolArgs(block.name, block.input);
	return (
		<Text>
			<Text color="cyan">⏵ </Text>
			{isRemote && <Text dimColor>[remote] </Text>}
			<Text color="cyan" bold>
				{name}
			</Text>
			{argSummary ? <Text dimColor> {argSummary}</Text> : null}
		</Text>
	);
}

/**
 * Wraps content in a colored left-edge stripe to visually anchor a turn.
 * User messages get a green stripe; assistant messages and their tool
 * calls/results share a blue stripe so the eye can follow a single turn
 * down the page even when it spans many child blocks.
 *
 * `width` is the explicit column budget for the stripe + content. Without
 * it, Ink/Yoga sizes the box to its intrinsic content width and the
 * terminal soft-wraps any overflow at terminal-edge (column 0), which
 * places the wrapped fragment OUTSIDE the colored stripe and breaks the
 * visual continuity of a turn. Constraining `width` here makes Ink wrap
 * the content INSIDE the stripe via `<Text>`'s default `wrap="wrap"`,
 * which is propagated to descendants (Markdown, HighlightedLine, etc.)
 * transitively through the parent-bounded layout.
 */
function StripeBox({
	color,
	width,
	children,
}: {
	color: string;
	width: number;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Box
			flexDirection="column"
			width={width}
			borderStyle="single"
			borderLeft
			borderRight={false}
			borderTop={false}
			borderBottom={false}
			borderColor={color}
			paddingLeft={1}
		>
			{children}
		</Box>
	);
}

export interface MessageBlockProps {
	message: Message;
	/**
	 * Optional file path resolved from the originating tool_call. Set by
	 * ChatView for tool_result messages whose tool_call carried a `file_path`
	 * input — used to detect the language for syntax highlighting on read
	 * results. (Edit/write get filePath from their own tool_call args, not
	 * from this prop.)
	 */
	filePath?: string;
	/**
	 * Live terminal column count from `useTerminalSize()`. Forwarded into
	 * `StripeBox`'s `width` so long lines wrap inside the colored stripe
	 * instead of soft-wrapping at the terminal edge.
	 */
	terminalColumns: number;
}

/**
 * Renders a message based on its role and content.
 * - `"user"`: green left-stripe, "you" header, content
 * - `"assistant"`: blue left-stripe, "agent" header, content (string or ContentBlock[])
 * - `"tool_call"`: blue stripe (continues assistant turn), `⏵ name args` rows
 * - `"tool_result"`: blue stripe, `✓/✗ name · summary` with truncated body
 * - Pending placeholder: dimmed "Waiting for tool result..." text
 */
export function MessageBlock({
	message,
	filePath,
	terminalColumns,
}: MessageBlockProps): React.ReactElement {
	// Stripe width budget: leave 1 col of right-side gutter for terminals
	// that reserve a column for cursor/scrollbar artifacts, and floor at
	// 20 cols so absurdly-narrow terminals don't collapse the box.
	// Inner content renders at `stripeWidth - 2` (1 col stripe border +
	// 1 col paddingLeft) — that's the effective wrap column.
	const stripeWidth = Math.max(20, terminalColumns - 1);
	// Helper to render content with markdown support
	const renderContent = (content: string | ContentBlock[]): React.ReactElement => {
		if (typeof content === "string") {
			return <Markdown text={content} />;
		}

		// ContentBlock array - extract text blocks
		const textBlocks = content.filter((block) => block.type === "text");
		if (textBlocks.length === 0) {
			return <Text dimColor>[Non-text content]</Text>;
		}

		const combinedText = textBlocks
			.map((block) => (block as { type: "text"; text: string }).text)
			.join("\n\n");
		return <Markdown text={combinedText} />;
	};

	// Parse content if it's a JSON string
	let parsedContent: string | ContentBlock[] = message.content;
	try {
		if (typeof message.content === "string" && message.content.startsWith("[")) {
			const parsed = JSON.parse(message.content);
			if (Array.isArray(parsed)) {
				parsedContent = parsed;
			}
		}
	} catch {
		// Keep original content
	}

	// Render based on role
	if (message.role === "user") {
		return (
			<StripeBox color="green" width={stripeWidth}>
				<Text bold color="green">
					you
				</Text>
				{renderContent(parsedContent)}
			</StripeBox>
		);
	}

	if (message.role === "assistant") {
		return (
			<StripeBox color="blue" width={stripeWidth}>
				<Text bold color="blue">
					agent
				</Text>
				{renderContent(parsedContent)}
			</StripeBox>
		);
	}

	if (message.role === "tool_call") {
		// Parse tool_use blocks and inline assistant text from the content JSON.
		// The agent loop folds inline text ("I'll check that file") into the
		// tool_call row's content blocks alongside tool_use entries, so we need
		// to extract and render both.
		let toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }> = [];
		let inlineText = "";
		try {
			const blocks = JSON.parse(message.content);
			if (Array.isArray(blocks)) {
				toolUseBlocks = blocks.filter((b: { type?: string }) => b.type === "tool_use");
				const textBlocks = blocks.filter((b: { type?: string }) => b.type === "text") as Array<{
					type: "text";
					text: string;
				}>;
				inlineText = textBlocks
					.map((b) => b.text)
					.filter(Boolean)
					.join("\n\n");
			}
		} catch {
			// Non-parseable content — fall back to raw display
		}

		if (toolUseBlocks.length > 0) {
			return (
				<StripeBox color="blue" width={stripeWidth}>
					{inlineText && (
						<Box flexDirection="column" marginBottom={1}>
							<Text bold color="blue">
								agent
							</Text>
							<Markdown text={inlineText} />
						</Box>
					)}
					{toolUseBlocks.map((block, idx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: tool_use blocks are immutable per render
						<ToolCallRow key={idx} block={block} />
					))}
				</StripeBox>
			);
		}

		return (
			<StripeBox color="blue" width={stripeWidth}>
				<Text>
					<Text color="cyan">⏵ </Text>
					<Text color="cyan" bold>
						{displayToolName(message.tool_name || "tool")}
					</Text>
					<Text dimColor>: {message.content}</Text>
				</Text>
			</StripeBox>
		);
	}

	if (message.role === "tool_result") {
		// Filter out [boundless] provenance blocks — they're useful for the agent
		// but noise in the TUI (the tool name is already in the header).
		let filteredContent = parsedContent;
		if (Array.isArray(parsedContent)) {
			const nonProvenance = parsedContent.filter(
				(block) =>
					block.type !== "text" ||
					!(block as { type: "text"; text: string }).text.startsWith("[boundless]"),
			);
			if (nonProvenance.length > 0) {
				filteredContent = nonProvenance;
			}
		}

		// Flatten all text into lines and truncate to keep the TUI compact
		const fullText =
			typeof filteredContent === "string"
				? filteredContent
				: filteredContent
						.filter((b) => b.type === "text")
						.map((b) => (b as { type: "text"; text: string }).text)
						.join("\n");
		// Strip leading/trailing blank lines so truncation shows meaningful content
		const rawLines = fullText.split("\n");
		const firstNonEmpty = rawLines.findIndex((l: string) => l.trim().length > 0);
		let lastNonEmpty = -1;
		for (let i = rawLines.length - 1; i >= 0; i--) {
			if (rawLines[i].trim().length > 0) {
				lastNonEmpty = i;
				break;
			}
		}
		const allLines =
			firstNonEmpty >= 0 ? rawLines.slice(firstNonEmpty, lastNonEmpty + 1) : rawLines;

		// Echo the tool name on the result line so the parent tool_call is
		// visually re-anchored (especially helpful when results scroll past
		// the call header in long output).
		const isError = message.exit_code != null && message.exit_code !== 0;
		const indicator = isError ? "✗" : "✓";
		const indicatorColor = isError ? "red" : "green";
		const toolName = message.tool_name ? displayToolName(message.tool_name) : null;

		// When this tool_result is for a tool that operated on a file (read,
		// most importantly), the file path is resolved upstream via the
		// tool_use_id correlation map. Use it to:
		//   1. Show a meaningful header label — basename, not the first line of
		//      content (which would otherwise smush the file body into the row
		//      that already carries the indicator + tool name).
		//   2. Detect language for per-line syntax highlighting via the shared
		//      shiki singleton.
		// Errors won't have line-numbered output, so the regex check below
		// gracefully degrades to plain text rendering.
		const lang = !isError ? langFromPath(filePath) : undefined;
		const baseName = filePath ? (filePath.split("/").pop() ?? null) : null;
		const headerLabel = baseName ?? tildifyText(allLines[0] ?? "");
		const rawBodyLines = (baseName ? allLines : allLines.slice(1)).map(tildifyText);

		// Pre-wrap body lines at the measured visual width when there is no
		// syntax highlighting active. Two regressions fall out of leaving Ink
		// to wrap arbitrarily-long body lines on its own:
		//   - Issue #74: a single 50,000-char line counts as one logical line
		//     and slips past the line-count truncation, blowing out the
		//     terminal at render time.
		//   - Issue #75: Ink Text inside a borderLeft Box drops the left
		//     stripe on the first wrapped continuation when an unbreakable
		//     string is one codepoint over the available width.
		// Pre-wrapping fixes both: every visual row is a separate Text of
		// known length, so Ink never wraps mid-string and truncation can
		// count visual rows. Width budget = stripeWidth − (StripeBox
		// borderLeft 1 + StripeBox paddingLeft 1) − inner Box paddingLeft 2
		// − per-line "  " prefix 2 = stripeWidth − 6, floored at 10 so a
		// pathologically narrow terminal still produces forward progress.
		// Syntax-highlighted lines are left untouched: the renderer keys off
		// a line-number regex that would not match past a wrap point, and
		// `read` output rarely contains the unbreakable lines that motivate
		// this fix.
		const bodyWrapWidth = Math.max(10, stripeWidth - 6);
		const expandedBodyLines = lang ? rawBodyLines : wrapLinesAtWidth(rawBodyLines, bodyWrapWidth);
		const truncated = expandedBodyLines.length > TOOL_RESULT_MAX_LINES;
		const bodyLines = truncated
			? expandedBodyLines.slice(0, TOOL_RESULT_MAX_LINES)
			: expandedBodyLines;
		const truncatedRemainder = expandedBodyLines.length - TOOL_RESULT_MAX_LINES;

		const lineNumPattern = /^(\s*\d+)\t(.*)$/;
		const renderResultLine = (line: string, idx: number): React.ReactElement => {
			if (lang) {
				const match = line.match(lineNumPattern);
				if (match) {
					const [, lineNum, code] = match;
					return (
						<Text key={idx}>
							{"  "}
							<Text dimColor>{lineNum}</Text>
							{"\t"}
							<HighlightedLine line={code} lang={lang} />
						</Text>
					);
				}
			}
			return (
				<Text key={idx}>
					{"  "}
					{line}
				</Text>
			);
		};

		return (
			<StripeBox color="blue" width={stripeWidth}>
				<Box flexDirection="column" paddingLeft={2}>
					<Text>
						<Text color={indicatorColor} bold>
							{indicator}
						</Text>
						{toolName ? (
							<>
								<Text dimColor> {toolName} · </Text>
							</>
						) : (
							<Text> </Text>
						)}
						<Text>{headerLabel}</Text>
					</Text>
					{bodyLines.map((line, idx) => renderResultLine(line, idx))}
					{truncated && (
						<Text dimColor>
							{"  "}… {truncatedRemainder} more lines
						</Text>
					)}
				</Box>
			</StripeBox>
		);
	}

	if (message.role === "alert") {
		return (
			<Text color="red">
				{typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent)}
			</Text>
		);
	}

	if (message.role === "system") {
		return (
			<Text dimColor>
				{typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent)}
			</Text>
		);
	}

	// Fallback for other roles
	return (
		<Text dimColor>
			[{message.role}:{" "}
			{typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent)}]
		</Text>
	);
}
