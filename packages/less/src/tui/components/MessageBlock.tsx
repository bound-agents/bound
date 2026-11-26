import { readFileSync } from "node:fs";
import path from "node:path";
import type { ContentBlock } from "@bound/llm";
import { type Message, applyHashlineEdits } from "@bound/shared";
import { resolveUserMessageSender } from "@bound/shared/message-sender";
import { Box, Text } from "ink";
import type React from "react";
import { PENDING_USER_MESSAGE_ID } from "../hooks/useMessages";
import { tokens } from "../theme";
import { parseAuthChallengeNotice } from "../util/auth-challenge";
import { getImageGraphics, getImagePreview, parseImageDescription } from "../util/image-preview";
import { parseMessageContent } from "../util/message-text";
import { linkifyPath } from "../util/osc8";
import { tildifyPath, tildifyText } from "../util/path";
import { stripTerminalControlSequences } from "../util/terminal-control";
import {
	classifyTool,
	displayToolName,
	isCompactToolName,
	toolTargetPath,
} from "../util/tool-names";
import {
	SLOW_TOOL_MS,
	analyzeToolCallContent,
	exitCodeHint,
	formatDuration,
	parseQuerySummary,
	parseSearchSummary,
	summarizeToolArgs,
	textContentLines,
	withoutBoundlessProvenance,
} from "../util/transcript";
import { expandTabs, wrapLinesAtWidth } from "../util/wrap";
import { GraphicsImage } from "./GraphicsImage";
import { HighlightedWrappedLine, langFromPath } from "./HighlightedCode";
import { Markdown } from "./Markdown";

// Keep a full terminal-sized excerpt for shell output. A five-row preview hid the
// useful part of ordinary commands (for example, a deliberately bounded `tail
// -25`), while the 256 KiB dispatch cap still prevents unbounded transcript growth.
const TOOL_RESULT_MAX_LINES = 32;
/**
 * Head/tail split of the body budget when a result truncates. Build/test
 * output puts its verdict on the LAST lines (`0 fail`, `error: …`, exit
 * summaries), so head-only truncation kept the preamble and cut the signal.
 * An even 16+16 split preserves enough setup for diagnostics without losing
 * the result summary at the end.
 */
const TOOL_RESULT_HEAD_ROWS = 16;
const TOOL_RESULT_TAIL_ROWS = 16;

function clipToolResultSourceLines(lines: string[]): { text: string; omitted: number } {
	if (lines.length <= TOOL_RESULT_MAX_LINES) return { text: lines.join("\n"), omitted: 0 };
	const omitted = lines.length - TOOL_RESULT_HEAD_ROWS - TOOL_RESULT_TAIL_ROWS;
	const clipped = [
		...lines.slice(0, TOOL_RESULT_HEAD_ROWS),
		`… ${omitted} more ${omitted === 1 ? "line" : "lines"}`,
		...lines.slice(lines.length - TOOL_RESULT_TAIL_ROWS),
	];
	const openFences = clipped.reduce((count, line) => (/^\s*```/.test(line) ? count + 1 : count), 0);
	if (openFences % 2 === 1) clipped.push("```");
	return { text: clipped.join("\n"), omitted };
}
/** Hard cap on rendered diff entries (after hunking) per edit call. */
const EDIT_DIFF_MAX_LINES = 24;
/** Preview lines shown under a `boundless_write` call. */
const WRITE_PREVIEW_MAX_LINES = 8;

/**
 * Duration fragment with magnitude color-grading: dim under 10s, yellow to a
 * minute, red beyond. The thresholds are terminal-scale, not SLA-scale — the
 * point is that the ONE slow call pops out of a wall of green ✓ rows without
 * the reader parsing every number.
 */
function DurationFragment({ ms }: { ms: number }): React.ReactElement {
	const color =
		ms >= 60_000 ? tokens.durationCritical : ms >= 10_000 ? tokens.durationCaution : undefined;
	return color ? (
		<Text color={color}> · {formatDuration(ms)}</Text>
	) : (
		<Text dimColor> · {formatDuration(ms)}</Text>
	);
}

/** Shape of one hashline edit as carried in edit args. */
type HashlineEditArg = { start: string; end: string; content: string };

type DiffLine = { kind: "same" | "added" | "removed"; text: string };
type EditDiff = { lines: DiffLine[]; added: number; removed: number; measured: boolean };

/** Narrow an unknown `edits` arg into the hashline edit list (best-effort). */
function asHashlineEdits(raw: unknown): HashlineEditArg[] {
	if (!Array.isArray(raw)) return [];
	const out: HashlineEditArg[] = [];
	for (const e of raw) {
		if (
			typeof e === "object" &&
			e !== null &&
			typeof (e as Record<string, unknown>).start === "string" &&
			typeof (e as Record<string, unknown>).end === "string" &&
			typeof (e as Record<string, unknown>).content === "string"
		) {
			out.push(e as HashlineEditArg);
		}
	}
	return out;
}

function splitDiffLines(text: string): string[] {
	if (text === "") return [];
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Small line-level LCS diff; edit previews are capped and source files are ordinary code files. */
function lineDiff(before: string, after: string): DiffLine[] {
	const a = splitDiffLines(before);
	const b = splitDiffLines(after);
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			lines.push({ kind: "same", text: a[i++] });
			j++;
		} else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
			lines.push({ kind: "added", text: b[j++] });
		} else {
			lines.push({ kind: "removed", text: a[i++] });
		}
	}
	return lines;
}

function estimateEditDiff(edits: HashlineEditArg[]): EditDiff {
	let added = 0;
	let removed = 0;
	for (const edit of edits) {
		added += edit.content === "" ? 0 : edit.content.split("\n").length;
		const start = Number.parseInt(edit.start, 10);
		const end = Number.parseInt(edit.end, 10);
		if (Number.isFinite(start) && Number.isFinite(end)) removed += Math.max(0, end - start + 1);
	}
	return { lines: [], added, removed, measured: false };
}

function measureEditDiff(
	filePath: string | null | undefined,
	edits: HashlineEditArg[],
	cwd?: string,
): EditDiff {
	const fallback = estimateEditDiff(edits);
	if (!filePath || edits.length === 0) return fallback;
	try {
		const absolute = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd ?? process.cwd(), filePath);
		const before = readFileSync(absolute, "utf-8");
		const applied = applyHashlineEdits(before, edits);
		if (!applied.ok) return fallback;
		const lines = lineDiff(before, applied.content);
		return {
			lines,
			added: lines.filter((line) => line.kind === "added").length,
			removed: lines.filter((line) => line.kind === "removed").length,
			measured: true,
		};
	} catch {
		return fallback;
	}
}

/** Render a measured local edit diff, or the anchor estimate when the file cannot be read. */
function HashlineEditsBody({
	edits,
	filePath,
	cwd,
	width,
}: {
	edits: HashlineEditArg[];
	filePath?: string | null;
	cwd?: string;
	/** Content column budget INSIDE the paddingLeft={2} body box (#239). */
	width?: number;
}): React.ReactElement | null {
	if (edits.length === 0) return null;
	// Code budget per row: body width minus the 2-col diff gutter.
	const codeWidth = width !== undefined ? Math.max(10, width - 2) : undefined;
	const lang = langFromPath(filePath);
	const diff = measureEditDiff(filePath, edits, cwd);
	if (diff.measured) {
		const changed = diff.lines.filter((line) => line.kind !== "same");
		const visible = changed.slice(0, EDIT_DIFF_MAX_LINES);
		return (
			<Box flexDirection="column" paddingLeft={2}>
				{visible.map((line, idx) => (
					<HighlightedWrappedLine
						// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are immutable per render
						key={idx}
						line={expandTabs(line.text)}
						lang={lang}
						width={codeWidth}
						dim={line.kind === "removed"}
						firstPrefix={
							<Text color={line.kind === "added" ? tokens.diffAdded : tokens.diffRemoved}>
								{line.kind === "added" ? "+ " : "− "}
							</Text>
						}
						contIndent="  "
					/>
				))}
				{changed.length > visible.length && (
					<Text dimColor>⋯ {changed.length - visible.length} more lines</Text>
				)}
			</Box>
		);
	}

	let budget = EDIT_DIFF_MAX_LINES;
	const rows: React.ReactElement[] = [];
	let truncatedLines = 0;
	for (let ei = 0; ei < edits.length; ei++) {
		const edit = edits[ei];
		const range = edit.start === edit.end ? edit.start : `${edit.start} → ${edit.end}`;
		const contentLines = edit.content === "" ? [] : expandTabs(edit.content).split("\n");
		if (budget <= 0) {
			truncatedLines += contentLines.length + 1;
			continue;
		}
		budget--;
		const startLine = Number.parseInt(edit.start, 10);
		const endLine = Number.parseInt(edit.end, 10);
		const removedCount =
			Number.isFinite(startLine) && Number.isFinite(endLine)
				? Math.max(0, endLine - startLine + 1)
				: null;
		rows.push(
			<Text key={`h${ei}`}>
				<Text color={tokens.diffRemoved}>− </Text>
				<Text dimColor>
					{range}
					{removedCount != null
						? ` · ~${removedCount} ${removedCount === 1 ? "line" : "lines"}`
						: ""}
				</Text>
			</Text>,
		);
		for (let li = 0; li < contentLines.length; li++) {
			if (budget <= 0) {
				truncatedLines += contentLines.length - li;
				break;
			}
			budget--;
			rows.push(
				<HighlightedWrappedLine
					key={`l${ei}-${li}`}
					line={contentLines[li]}
					lang={lang}
					width={codeWidth}
					firstPrefix={<Text color={tokens.diffAdded}>+ </Text>}
					contIndent="  "
				/>,
			);
		}
	}
	return (
		<Box flexDirection="column" paddingLeft={2}>
			{rows}
			{truncatedLines > 0 && <Text dimColor>⋯ {truncatedLines} more lines</Text>}
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
	width,
}: {
	content: string;
	filePath?: string | null;
	/** Content column budget INSIDE the paddingLeft={2} body box (#239). */
	width?: number;
}): React.ReactElement | null {
	if (content.length === 0) {
		return null;
	}
	const codeWidth = width !== undefined ? Math.max(10, width - 2) : undefined;
	const lines = expandTabs(content).split("\n");
	const truncated = lines.length > WRITE_PREVIEW_MAX_LINES;
	const display = truncated ? lines.slice(0, WRITE_PREVIEW_MAX_LINES) : lines;
	const lang = langFromPath(filePath);
	return (
		<Box flexDirection="column" paddingLeft={2}>
			{display.map((line, idx) => (
				<HighlightedWrappedLine
					// biome-ignore lint/suspicious/noArrayIndexKey: preview lines are immutable per render
					key={idx}
					line={line}
					lang={lang}
					width={codeWidth}
					firstPrefix={<Text color={tokens.diffAdded}>+ </Text>}
					contIndent="  "
				/>
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
	cwd,
	width,
}: {
	block: { name: string; input: Record<string, unknown> };
	cwd?: string;
	/** Stripe content width; preview bodies subtract their own chrome (#239). */
	width?: number;
}): React.ReactElement {
	// Bodies render inside a paddingLeft={2} box.
	const bodyWidth = width !== undefined ? Math.max(10, width - 2) : undefined;
	const isRemote = !block.name.startsWith("boundless_");
	const name = displayToolName(block.name);
	const filePath = toolTargetPath(block.input) ?? null;
	// `displayPath` is the tildified version for header rendering; we keep the
	// original `filePath` for HashlineEditsBody / WritePreviewBody, which use it for
	// syntax-highlighting language detection. `linkedPath` wraps the display
	// label in an OSC 8 file:// hyperlink so it's clickable in supporting terminals.
	const displayPath = filePath ? tildifyPath(filePath) : null;
	const linkedPath = displayPath ? linkifyPath(displayPath, filePath, cwd) : null;
	const requestLabel = (detail?: React.ReactNode) => (
		<Text>
			<Text color={tokens.toolRequestMarker}>⏵ </Text>
			<Text color={tokens.toolRequestMarker} bold>
				{name}
			</Text>
			<Text dimColor>
				{" "}
				{linkedPath}
				{detail}
			</Text>
		</Text>
	);

	// boundless_edit: header + per-edit anchor ranges with added-line previews
	if (block.name === "boundless_edit" && filePath) {
		const edits = asHashlineEdits(block.input.edits);
		return (
			<Box flexDirection="column">
				{requestLabel()}
				<HashlineEditsBody edits={edits} filePath={filePath} cwd={cwd} width={bodyWidth} />
			</Box>
		);
	}

	// boundless_write: header + first-N-lines content preview as adds
	if (block.name === "boundless_write" && filePath) {
		const content = typeof block.input.content === "string" ? block.input.content : "";
		const lineCount = content.length === 0 ? 0 : content.split("\n").length;
		return (
			<Box flexDirection="column">
				{requestLabel(
					<>
						{" "}
						· {lineCount} {lineCount === 1 ? "line" : "lines"}
					</>,
				)}
				<WritePreviewBody content={content} filePath={filePath} width={bodyWidth} />
			</Box>
		);
	}

	// Generic single-line rendering for everything else.
	const argSummary = summarizeToolArgs(block.name, block.input);
	return (
		<Text>
			<Text color={tokens.toolRequestMarker}>⏵ </Text>
			{isRemote && <Text dimColor>[remote] </Text>}
			<Text color={tokens.toolRequestMarker} bold>
				{name}
			</Text>
			{argSummary ? <Text dimColor> {argSummary}</Text> : null}
		</Text>
	);
}

/**
 * Wraps content in a colored left-edge stripe to visually anchor a turn.
 * User messages get a green stripe; assistant messages and their tool
 * calls/results share a cyan stripe so the eye can follow a single turn
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
export function StripeBox({
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

function formatCompactCount(value: number): string {
	return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
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
	 * The originating tool_call's tool name (e.g. "boundless_read"), resolved by
	 * ChatView through the tool_use_id correlation map. Rendered on tool_result
	 * header lines. The result row's own `tool_name` column holds the opaque
	 * tool_use_id, not a name, so this prop is the only source of a human name
	 * for the result header.
	 */
	toolName?: string;
	/**
	 * The originating tool_use's `input` args, resolved by ChatView through the
	 * same correlation map as `toolName`. Compact read/search result lines pull
	 * their target (file path / search pattern) from here.
	 */
	toolInput?: Record<string, unknown>;
	/**
	 * Render a ⏵ request row above this result, reconstructed from
	 * `toolName` + `toolInput`. Set by ChatView for results whose originating
	 * call was a PARALLEL group: the call's own ⏵ rows are suppressed there
	 * (<Static> commits them before any result exists, so pairing request with
	 * result is only possible by re-rendering the request on the result).
	 */
	showRequest?: boolean;
	/**
	 * `created_at` of the originating tool_call message, resolved by ChatView
	 * through the correlation map. Paired with this result's own `created_at`
	 * it yields the call's wall-clock duration — both timestamps are frozen by
	 * the time the row commits, so the rendered fragment is Static-safe.
	 */
	callCreatedAt?: string;
	/**
	 * One-line summary of the tool activity that led to this assistant
	 * message (`14 tools · 1m 40s`), computed by ChatView's
	 * `buildTurnActivityMap`. Rendered dim after the `agent` header so the
	 * reader knows what the turn cost at the moment they start reading its
	 * conclusion. Only set for assistant messages that follow tool activity.
	 */
	activitySummary?: string;
	/**
	 * Live terminal column count from `useTerminalSize()`. Forwarded into
	 * `StripeBox`'s `width` so long lines wrap inside the colored stripe
	 * instead of soft-wrapping at the terminal edge.
	 */
	terminalColumns: number;
	/**
	 * Working directory of the boundless session, forwarded from ChatView.
	 * Used to resolve repo-relative tool paths into absolute `file://` URIs so
	 * file targets render as clickable OSC 8 hyperlinks. Optional: without it,
	 * only already-absolute paths linkify, and everything degrades to plain text.
	 */
	cwd?: string;
	/**
	 * The thread owner's `users.display_name`, labelling user rows that carry no
	 * stamped `user_name` (#258). Without it such rows keep the `you` header.
	 */
	userDisplayName?: string | null;
}

/**
 * Renders a message based on its role and content.
 * - `"user"`: green left-stripe, sender header (stamped `user_name`, the thread
 *   owner's display name, `agent` for a main→aux message, else "you"), content
 * - `"assistant"`: cyan left-stripe, "agent" header, content (string or ContentBlock[])
 * - `"tool_call"`: cyan stripe (continues assistant turn), `⏵ name args` rows
 * - `"tool_result"`: cyan stripe, `✓/✗ name · summary` with truncated body
 * - Pending placeholder: dimmed "Waiting for tool result..." text
 */
export function MessageBlock({
	message,
	filePath,
	toolName: resolvedToolName,
	toolInput,
	showRequest,
	callCreatedAt,
	activitySummary,
	terminalColumns,
	cwd,
	userDisplayName,
}: MessageBlockProps): React.ReactElement {
	// Stripe width budget: leave 1 col of right-side gutter for terminals
	// that reserve a column for cursor/scrollbar artifacts, and floor at
	// 20 cols so absurdly-narrow terminals don't collapse the box.
	// Inner content renders at `stripeWidth - 2` (1 col stripe border +
	// 1 col paddingLeft) — that's the effective wrap column.
	const stripeWidth = Math.max(20, terminalColumns - 1);
	const contentWidth = Math.max(10, stripeWidth - 2);
	// Helper to render content with markdown support
	const renderContent = (content: string | ContentBlock[]): React.ReactElement => {
		if (typeof content === "string") {
			return <Markdown text={stripTerminalControlSequences(content)} width={contentWidth} />;
		}

		// ContentBlock array — render text and image blocks in order. Image
		// previews come from the session-local cache keyed by the pv: hash in
		// the block description (stamped at paste time; survives the server's
		// base64→file_ref rewrite). The preview lines are half-block art —
		// pure SGR color runs, one physical row per line, so they render as
		// ordinary Text rows (the ghost-card invariant holds by construction).
		// Foreign images (other sessions/hosts) miss the cache and render as
		// a dim placeholder instead — their bytes were never on this clipboard.
		const parts: React.ReactNode[] = [];
		let textRun: string[] = [];
		let key = 0;
		const flushText = () => {
			if (textRun.length === 0) return;
			parts.push(<Markdown key={`t-${key++}`} text={textRun.join("\n\n")} width={contentWidth} />);
			textRun = [];
		};
		for (const block of content) {
			if (block.type === "text") {
				textRun.push(stripTerminalControlSequences((block as { type: "text"; text: string }).text));
			} else if (block.type === "image") {
				flushText();
				const { label, hash } = parseImageDescription(
					(block as { type: "image"; description?: string }).description,
				);
				const graphics = hash ? getImageGraphics(hash) : undefined;
				const preview = hash ? getImagePreview(hash) : undefined;
				parts.push(
					<Box key={`i-${key++}`} flexDirection="column">
						{graphics ? (
							<GraphicsImage escape={graphics.escape} rows={graphics.rows} mode={graphics.mode} />
						) : (
							preview?.map((line, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: preview lines are immutable per render
								<Text key={i}>{line}</Text>
							))
						)}
						<Text dimColor>[{label}]</Text>
					</Box>,
				);
			}
		}
		flushText();
		if (parts.length === 0) {
			return <Text dimColor>[Non-text content]</Text>;
		}
		return <Box flexDirection="column">{parts}</Box>;
	};

	const parsedContent = parseMessageContent<ContentBlock>(message.content);

	// Render based on role
	if (message.role === "user") {
		// Optimistic placeholder (#88): the user's message is echoed locally
		// before the server persists + broadcasts it. Render dimmed with a
		// "sending…" cue so it reads as in-flight, not yet committed.
		const isPending = message.id === PENDING_USER_MESSAGE_ID;
		const senderLabel =
			resolveUserMessageSender({ metadata: message.metadata, userDisplayName }).name ?? "you";
		return (
			<StripeBox color={isPending ? tokens.pendingStripe : tokens.userStripe} width={stripeWidth}>
				<Text bold color={isPending ? tokens.pendingStripe : tokens.userStripe}>
					{senderLabel}
					{isPending ? <Text dimColor> · sending…</Text> : null}
				</Text>
				{isPending ? (
					<Text dimColor>
						{typeof parsedContent === "string" ? stripTerminalControlSequences(parsedContent) : ""}
					</Text>
				) : (
					renderContent(parsedContent)
				)}
			</StripeBox>
		);
	}

	if (message.role === "assistant") {
		let cacheUsage: { read: number; write: number } | null = null;
		try {
			const metadata = JSON.parse(message.metadata ?? "null") as {
				cache_usage?: { read?: unknown; write?: unknown };
			} | null;
			const read = metadata?.cache_usage?.read;
			const write = metadata?.cache_usage?.write;
			if (typeof read === "number" && typeof write === "number" && (read > 0 || write > 0)) {
				cacheUsage = { read, write };
			}
		} catch {
			// Malformed metadata is not card content.
		}
		const cacheFragment = cacheUsage
			? `cache ${formatCompactCount(cacheUsage.read)} r / ${formatCompactCount(cacheUsage.write)} w`
			: null;
		return (
			<StripeBox color={tokens.agentStripe} width={stripeWidth}>
				<Text>
					<Text bold color={tokens.agentStripe}>
						agent
					</Text>
					{activitySummary ? <Text dimColor> · {activitySummary}</Text> : null}
					{cacheFragment ? <Text dimColor> · {cacheFragment}</Text> : null}
				</Text>
				{renderContent(parsedContent)}
			</StripeBox>
		);
	}

	if (message.role === "tool_call") {
		// Parse tool_use blocks + inline assistant text via the shared analyzer
		// (ChatView uses the same one for margin layout, so suppression stays in
		// lockstep). Two kinds of use don't get ⏵ rows here: compact read/search
		// (one line on the result carries the invocation) and parallel groups
		// (each request row renders atop its own result so pairs read adjacently).
		const { toolUses, inlineText, suppressed } = analyzeToolCallContent(message.content);
		if (suppressed) {
			// Nothing to commit: all-compact or parallel with no inline text. The
			// dynamic in-flight card covers the running state; the result rows
			// carry the invocations.
			return <></>;
		}
		const toolUseBlocks =
			toolUses.length > 1
				? []
				: toolUses.filter((b) => !isCompactToolName(b.name) && b.name !== "yard");

		if (toolUses.length > 0) {
			return (
				<StripeBox color={tokens.agentStripe} width={stripeWidth}>
					{inlineText && (
						<Box flexDirection="column" marginBottom={toolUseBlocks.length > 0 ? 1 : 0}>
							<Text bold color={tokens.agentStripe}>
								agent
							</Text>
							<Markdown text={inlineText} width={contentWidth} />
						</Box>
					)}
					{toolUseBlocks.map((block, idx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: tool_use blocks are immutable per render
						<ToolCallRow key={idx} block={block} cwd={cwd} width={Math.max(10, stripeWidth - 2)} />
					))}
				</StripeBox>
			);
		}

		return (
			<StripeBox color={tokens.agentStripe} width={stripeWidth}>
				<Text>
					<Text color={tokens.toolRequestMarker}>⏵ </Text>
					<Text color={tokens.toolRequestMarker} bold>
						{displayToolName(message.tool_name || "tool")}
					</Text>
					<Text dimColor>: {stripTerminalControlSequences(message.content)}</Text>
				</Text>
			</StripeBox>
		);
	}

	if (message.role === "tool_result") {
		const filteredContent = withoutBoundlessProvenance(parsedContent);
		const allLines = textContentLines(filteredContent);
		const fullText = allLines.join("\n");
		if (resolvedToolName === "aux") {
			const clipped = clipToolResultSourceLines(allLines);
			return (
				<StripeBox color={tokens.agentStripe} width={stripeWidth}>
					<Box flexDirection="column" paddingLeft={2}>
						<Text>
							<Text color={tokens.successIndicator} bold>
								✓
							</Text>
							<Text dimColor> aux</Text>
						</Text>
						<Markdown text={clipped.text} width={Math.max(10, contentWidth - 2)} />
					</Box>
				</StripeBox>
			);
		}

		// MCP OAuth consent notice (R-MO27a): a settled `auth_challenge_raised`
		// result renders as a distinct consent NOTICE — visually shaped like a
		// client-tool confirmation, but mechanically just a rendered tool result.
		// Nothing blocks: the call already settled (R-MO14), the thread stays
		// usable, and this block only surfaces the resolution affordances. The
		// notice keys off the formatter's text shape (parseAuthChallengeNotice).
		const authNotice = parseAuthChallengeNotice(fullText);
		if (authNotice) {
			return (
				<StripeBox color={tokens.systemStripe} width={stripeWidth}>
					<Box flexDirection="column" paddingLeft={2}>
						<Text bold color={tokens.systemStripe}>
							🔐 authorization required
						</Text>
						<Text>
							<Text dimColor>server: </Text>
							<Text bold>{authNotice.serverName}</Text>
						</Text>
						<Text>
							<Text dimColor>{authNotice.scopeLine}</Text>
						</Text>
						{authNotice.failureLine ? (
							<Text color={tokens.failureIndicator}>{authNotice.failureLine}</Text>
						) : null}
						<Text>
							<Text dimColor>challenge: </Text>
							<Text>{authNotice.challengeId}</Text>
						</Text>
						<Box marginTop={1} flexDirection="column">
							<Text>
								<Text color={tokens.toolRequestMarker}>{"  • "}</Text>
								<Text>{`bound login --challenge ${authNotice.challengeId}`}</Text>
							</Text>
							<Text>
								<Text color={tokens.toolRequestMarker}>{"  • "}</Text>
								<Text dimColor>or open the consent card in the web UI</Text>
							</Text>
							<Text dimColor>{"  This thread is woken when the challenge resolves."}</Text>
						</Box>
					</Box>
				</StripeBox>
			);
		}

		// Echo the tool name on the result line so the parent tool_call is
		// visually re-anchored (especially helpful when results scroll past
		// the call header in long output).
		const isError = message.exit_code != null && message.exit_code !== 0;
		const indicator = isError ? "✗" : "✓";
		const indicatorColor = isError ? tokens.failureIndicator : tokens.successIndicator;
		// Render the tool NAME resolved upstream (e.g. "read"), never
		// `message.tool_name` — on tool_result rows that column holds the opaque
		// tool_use_id, which is noise in the TUI. When the name can't be resolved
		// (orphan result), show no label rather than echo the id.
		const toolName = resolvedToolName ? displayToolName(resolvedToolName) : null;
		// #215: collapsed one-line results are the invocation's whole committed
		// footprint when the ⏵ call row is suppressed (compact tools) or reduced
		// to a status line (edit/write) — without re-carrying the [remote] tag
		// here, a remote read/edit is indistinguishable from a local one. Same
		// predicate as ToolCallRow: everything not boundless_* runs server-side.
		const isRemoteResult = resolvedToolName ? !resolvedToolName.startsWith("boundless_") : false;

		// Wall-clock duration: result commit-time minus call commit-time. Both
		// ISO timestamps are frozen by the time this row renders, so the
		// fragment is Static-safe. Only slow calls render it — the spinner
		// covers live elapsed; this carries "where the turn's time went" into
		// scrollback without annotating every fast call.
		const durationMs = callCreatedAt
			? Date.parse(message.created_at) - Date.parse(callCreatedAt)
			: Number.NaN;
		const slow = Number.isFinite(durationMs) && durationMs >= SLOW_TOOL_MS;
		// Exit codes carry diagnostic signal beyond the ✗ itself — 127 is
		// command-not-found, 124 a timeout, 2 usage error. The generic `exit 1`
		// stays quiet; it adds nothing over the indicator.
		const showExit = isError && message.exit_code != null && message.exit_code !== 1;

		// Compact read/search/query results render as ONE line per invocation: the
		// ⏵ call row was suppressed upstream, so this line is the invocation's
		// whole committed footprint — target plus a useful volume summary instead
		// of a body preview. Errors skip this branch and keep the full rendering
		// below so failures stay visible.
		if (resolvedToolName && isCompactToolName(resolvedToolName) && !isError) {
			const isSearch = classifyTool(resolvedToolName) === "search";
			const isQuery = classifyTool(resolvedToolName) === "query";
			const lineCount = `${allLines.length} ${allLines.length === 1 ? "line" : "lines"}`;
			const target = isSearch
				? typeof toolInput?.pattern === "string"
					? toolInput.pattern
					: tildifyText(allLines[0] ?? "")
				: isQuery
					? typeof toolInput?.sql === "string"
						? toolInput.sql
						: "query"
					: filePath
						? tildifyPath(filePath)
						: tildifyText(allLines[0] ?? "");
			// Read targets are file paths → clickable file:// links. Search patterns
			// and SQL statements are plain text.
			const linkedTarget =
				!isSearch && !isQuery && filePath ? linkifyPath(target, filePath, cwd) : target;
			const summary = isSearch
				? (parseSearchSummary(allLines[allLines.length - 1] ?? "") ?? lineCount)
				: isQuery
					? parseQuerySummary(allLines)
					: lineCount;
			return (
				<StripeBox color={tokens.agentStripe} width={stripeWidth}>
					{/* No paddingLeft: this line IS the invocation (the ⏵ call row
					    was suppressed), so it sits at ⏵-column depth — indenting it
					    like a result body made it read as an orphaned extra result
					    of whatever call rendered above it. */}
					<Box>
						<Text wrap="wrap">
							<Text color={indicatorColor} bold>
								{indicator}
							</Text>
							{isRemoteResult && <Text dimColor> [remote]</Text>}
							<Text color={tokens.toolRequestMarker} bold>
								{" "}
								{toolName}
							</Text>
							<Text> {linkedTarget}</Text>
							<Text dimColor> · {summary}</Text>
							{slow ? <DurationFragment ms={durationMs} /> : null}
						</Text>
					</Box>
				</StripeBox>
			);
		}

		// Edit/write results collapse to one status line: the ⏵ call row
		// already rendered the full diff / content preview, so the result body
		// ("Edited path: applied N edits / New content …") repeats what's
		// already on screen. One line closes the request/result pair. Errors
		// skip this branch and keep the full rendering below.
		if (
			resolvedToolName &&
			(classifyTool(resolvedToolName) === "edit" || classifyTool(resolvedToolName) === "write") &&
			!isError
		) {
			const isEdit = classifyTool(resolvedToolName) === "edit";
			const editCount = Array.isArray(toolInput?.edits) ? toolInput.edits.length : null;
			const hashEdits = isEdit ? asHashlineEdits(toolInput?.edits) : [];
			const editPath = toolTargetPath(toolInput) ?? filePath;
			const diffStat = hashEdits.length > 0 ? measureEditDiff(editPath, hashEdits, cwd) : null;
			const writeLines =
				typeof toolInput?.content === "string"
					? toolInput.content.length === 0
						? 0
						: toolInput.content.split("\n").length
					: null;
			const summary = isEdit
				? editCount != null
					? `${editCount} ${editCount === 1 ? "edit" : "edits"} applied`
					: "applied"
				: writeLines != null
					? `${writeLines} ${writeLines === 1 ? "line" : "lines"} written`
					: "written";
			const target = filePath
				? (filePath.split("/").pop() ?? tildifyPath(filePath))
				: tildifyText(allLines[0] ?? "");
			const linkedTarget = filePath ? linkifyPath(target, filePath, cwd) : target;
			return (
				<StripeBox color={tokens.agentStripe} width={stripeWidth}>
					{/* Parallel groups: the call's listing is suppressed, so the
					    diff/preview rides here with the request row — without it the
					    change content would never commit at all. */}
					{showRequest && (
						<ToolCallRow
							block={{ name: resolvedToolName, input: toolInput ?? {} }}
							cwd={cwd}
							width={Math.max(10, stripeWidth - 2)}
						/>
					)}
					<Box paddingLeft={2}>
						<Text wrap="wrap">
							<Text color={indicatorColor} bold>
								{indicator}
							</Text>
							{isRemoteResult && <Text dimColor> [remote]</Text>}
							<Text dimColor> {toolName} · </Text>
							<Text>{linkedTarget}</Text>
							<Text dimColor> · {summary}</Text>
							{diffStat ? (
								<>
									<Text dimColor> · </Text>
									<Text color={tokens.diffAdded}>+{diffStat.added}</Text>
									<Text color={tokens.diffRemoved}>
										{" "}
										−{diffStat.measured ? "" : "~"}
										{diffStat.removed}
									</Text>
								</>
							) : null}
							{slow ? <DurationFragment ms={durationMs} /> : null}
						</Text>
					</Box>
				</StripeBox>
			);
		}

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
		// Offloaded results: everything after the marker line is usage coaching
		// for the AGENT ("Use bash to read or filter it…"), not information for
		// the operator. Keep the three facts a human needs — offloaded, how
		// big, where — and drop the rest.
		let offload: { label: string; lines: string[] } | null = null;
		if (!baseName && !isError) {
			const m = (allLines[0] ?? "").match(
				/^\[Tool result offloaded: (\d+) characters from "[^"]+"\]/,
			);
			if (m) {
				const chars = Number(m[1]).toLocaleString("en-US");
				const pathMatch = fullText.match(/saved to:\s*(\S+)/);
				offload = {
					label: `output offloaded · ${chars} chars`,
					lines: pathMatch ? [`→ ${pathMatch[1]}`] : [],
				};
			}
		}
		// JSON-shaped results (MCP/remote tools usually return one JSON blob):
		// pretty-print so body truncation operates on meaningful lines instead
		// of soft-wrapped fragments of a single giant line, and summarize the
		// shape in the header instead of echoing the blob itself.
		let jsonShape: { label: string; lines: string[] } | null = null;
		if (!baseName && !offload && !isError) {
			const trimmed = fullText.trim();
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					const parsed: unknown = JSON.parse(trimmed);
					if (parsed !== null && typeof parsed === "object") {
						const label = Array.isArray(parsed)
							? `JSON array · ${parsed.length} ${parsed.length === 1 ? "item" : "items"}`
							: `JSON object · ${Object.keys(parsed).length} ${
									Object.keys(parsed).length === 1 ? "key" : "keys"
								}`;
						jsonShape = { label, lines: JSON.stringify(parsed, null, 2).split("\n") };
					}
				} catch {
					// Not valid JSON — fall through to plain rendering.
				}
			}
		}
		const headerLabel =
			baseName ?? offload?.label ?? jsonShape?.label ?? tildifyText(allLines[0] ?? "");
		const rawBodyLines = (
			offload?.lines ??
			jsonShape?.lines ??
			(baseName ? allLines : allLines.slice(1))
		).map(tildifyText);

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
		// Tabs expand to spaces on the plain-text path so measured width equals
		// rendered width (see expandTabs). The `lang` path keeps its tabs: the
		// hashline renderer's line-number regex keys on a literal \t separator.
		const expandedBodyLines = lang
			? rawBodyLines
			: wrapLinesAtWidth(
					rawBodyLines.map((l) => expandTabs(l)),
					bodyWrapWidth,
				);
		// Head+tail split (see TOOL_RESULT_HEAD_ROWS): build/test output puts
		// its verdict on the LAST lines, so head-only truncation kept the
		// preamble and cut the signal.
		const totalBodyRows = expandedBodyLines.length;
		const truncated = totalBodyRows > TOOL_RESULT_MAX_LINES;
		const headLines = truncated
			? expandedBodyLines.slice(0, TOOL_RESULT_HEAD_ROWS)
			: expandedBodyLines;
		const tailLines = truncated
			? expandedBodyLines.slice(totalBodyRows - TOOL_RESULT_TAIL_ROWS)
			: [];
		const truncatedRemainder = totalBodyRows - TOOL_RESULT_HEAD_ROWS - TOOL_RESULT_TAIL_ROWS;

		const lineNumPattern = /^(\s*\d+)\t(.*)$/;
		const renderResultLine = (line: string, idx: number): React.ReactElement => {
			if (lang) {
				const match = line.match(lineNumPattern);
				if (match) {
					const [, lineNum, code] = match;
					// #239: tokenize the WHOLE code portion and slice at the
					// remaining width — handing a long line to Ink re-wrapped it
					// mid-token and the continuation rows lost their colors.
					// Continuations indent to the code column.
					const prefixCols = 2 + lineNum.length + 1;
					return (
						<HighlightedWrappedLine
							key={idx}
							line={expandTabs(code)}
							lang={lang}
							width={Math.max(10, bodyWrapWidth - prefixCols)}
							firstPrefix={
								<>
									{"  "}
									<Text dimColor>{lineNum}</Text>
									{"\t"}
								</>
							}
							contIndent={" ".repeat(prefixCols)}
						/>
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
			<StripeBox color={tokens.agentStripe} width={stripeWidth}>
				{/* Parallel-group results re-render their ⏵ request row here so
				    each result immediately follows its request — the call row's
				    own listing is suppressed because <Static> commits it before
				    any result exists and can never reorder it afterward. */}
				{showRequest && resolvedToolName && (
					<ToolCallRow
						block={{ name: resolvedToolName, input: toolInput ?? {} }}
						cwd={cwd}
						width={Math.max(10, stripeWidth - 2)}
					/>
				)}
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
						{showExit && message.exit_code != null ? (
							<Text color={tokens.failureIndicator}>
								{" "}
								· exit {message.exit_code}
								{exitCodeHint(message.exit_code) ? ` (${exitCodeHint(message.exit_code)})` : ""}
							</Text>
						) : null}
						{slow ? <DurationFragment ms={durationMs} /> : null}
					</Text>
					{headLines.map((line, idx) => renderResultLine(line, idx))}
					{truncated && (
						<Text dimColor>
							{"  "}… {truncatedRemainder} more {truncatedRemainder === 1 ? "line" : "lines"}
						</Text>
					)}
					{tailLines.map((line, idx) => renderResultLine(line, headLines.length + idx))}
				</Box>
			</StripeBox>
		);
	}

	if (message.role === "alert") {
		// System-generated error surfacing (e.g. failed inference). Red stripe
		// + "alert" header so it reads as a turn in the transcript like every
		// other message, not as raw floating text (#139).
		return (
			<StripeBox color={tokens.alertStripe} width={stripeWidth}>
				<Text bold color={tokens.alertStripe}>
					alert
				</Text>
				<Text color={tokens.alertStripe}>
					{stripTerminalControlSequences(
						typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent),
					)}
				</Text>
			</StripeBox>
		);
	}

	// System notifications. Per invariant #19, `role: "system"` is forbidden in
	// the messages table — injected system context (notify/introspect wakeups,
	// interruption notices) lands as `role: "developer"`. Both render with a
	// yellow stripe + "system" header so notifications read as transcript turns
	// rather than raw dimmed text (#139).
	if (message.role === "system" || message.role === "developer") {
		return (
			<StripeBox color={tokens.systemStripe} width={stripeWidth}>
				<Text bold color={tokens.systemStripe}>
					system
				</Text>
				<Text>
					{stripTerminalControlSequences(
						typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent),
					)}
				</Text>
			</StripeBox>
		);
	}

	// Fallback for other roles
	return (
		<Text dimColor>
			[{message.role}:{" "}
			{stripTerminalControlSequences(
				typeof parsedContent === "string" ? parsedContent : JSON.stringify(parsedContent),
			)}
			]
		</Text>
	);
}
