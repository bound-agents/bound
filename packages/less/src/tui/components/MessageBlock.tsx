import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { isShellToolName } from "../../tools/shell";
import { PENDING_USER_MESSAGE_ID } from "../hooks/useMessages";
import { getImageGraphics, getImagePreview, parseImageDescription } from "../util/image-preview";
import { linkifyPath } from "../util/osc8";
import { tildifyPath, tildifyText } from "../util/path";
import { stripTerminalControlSequences } from "../util/terminal-control";
import { expandTabs, wrapLinesAtWidth } from "../util/wrap";
import { GraphicsImage } from "./GraphicsImage";
import { HighlightedLine, langFromPath } from "./HighlightedCode";
import { Markdown } from "./Markdown";

const TOOL_RESULT_MAX_LINES = 5;
/**
 * Head/tail split of the body budget when a result truncates. Build/test
 * output puts its verdict on the LAST lines (`0 fail`, `error: …`, exit
 * summaries), so head-only truncation kept the preamble and cut the signal.
 * 2 head + 3 tail rows spend the same 5-row budget, biased toward the tail
 * where the verdict lives.
 */
const TOOL_RESULT_HEAD_ROWS = 2;
const TOOL_RESULT_TAIL_ROWS = 3;
/** Hard cap on rendered diff entries (after hunking) per edit call. */
const EDIT_DIFF_MAX_LINES = 24;
/** Preview lines shown under a `boundless_write` call. */
const WRITE_PREVIEW_MAX_LINES = 8;

/** Strip the "boundless_" prefix from local tool names for cleaner display. */
function displayToolName(name: string): string {
	if (name.startsWith("boundless_")) return name.slice("boundless_".length);
	if (name.startsWith("bms_")) return name.slice("bms_".length);
	return name;
}

/** One parsed tool_use block from a tool_call message's content JSON. */
export type ToolUseBlockLite = { name: string; input: Record<string, unknown> };

/**
 * Compact tools (read/search) collapse to one committed line per invocation —
 * the result row — instead of a ⏵ call row plus a multi-line result body.
 * These calls dominate coding sessions, so halving their vertical cost keeps
 * the transcript scannable. Matched by suffix so boundless_read / bms_read /
 * boundless_search / bms_search are all covered without enumerating surfaces.
 */
export function isCompactToolName(name: string): boolean {
	return name.endsWith("_read") || name.endsWith("_search");
}

/**
 * Parse a tool_call message's content into tool_use blocks + inline text, and
 * classify whether the whole call row is suppressed (commits nothing). Two
 * suppression cases:
 * - every use is a compact read/search (each invocation renders as one line
 *   on its result instead), or
 * - the call is a PARALLEL group (2+ uses): its ⏵ request rows render atop
 *   each result so request/result pairs read adjacently — <Static> commits
 *   the call row before any result exists, so pairing can only be achieved
 *   by moving the request line onto the result message.
 * Either way inline text still renders. Shared between MessageBlock
 * (rendering) and ChatView (margin layout) — the two must agree on
 * suppression or a zero-height row would still carry a 1-row margin.
 */
export function analyzeToolCallContent(content: string): {
	toolUses: ToolUseBlockLite[];
	inlineText: string;
	suppressed: boolean;
} {
	let toolUses: ToolUseBlockLite[] = [];
	let inlineText = "";
	try {
		const blocks = JSON.parse(content);
		if (Array.isArray(blocks)) {
			toolUses = blocks.filter((b: { type?: string }) => b.type === "tool_use");
			const textBlocks = blocks.filter((b: { type?: string }) => b.type === "text") as Array<{
				type: "text";
				text: string;
			}>;
			inlineText = textBlocks
				.map((b) => stripTerminalControlSequences(b.text))
				.filter(Boolean)
				.join("\n\n");
		}
	} catch {
		// Non-parseable content — caller falls back to raw display.
	}
	const suppressed =
		toolUses.length > 0 &&
		inlineText === "" &&
		(toolUses.length > 1 || toolUses.every((b) => isCompactToolName(b.name)));
	return { toolUses, inlineText, suppressed };
}

/**
 * Parse the shared search-result footer ("N matches in M files (K files
 * searched)" / "No matches found (K files searched).") into the compact
 * summary fragment. Returns null when the line isn't the shared footer
 * (an error result or a differently-shaped remote tool) so the caller can
 * fall back to a plain line count.
 */
function parseSearchSummary(lastLine: string): string | null {
	if (/^No matches found \(\d+ files? searched\)\.?/.test(lastLine)) return "no matches";
	const m = lastLine.match(/^(\d+ match(?:es)? in \d+ files?) \(\d+ files? searched\)/);
	return m ? m[1] : null;
}

/**
 * Threshold for showing a duration fragment on committed result rows. The
 * spinner already shows elapsed time while a tool runs; the committed row
 * used to forget it. Fast calls stay unannotated — a duration on every row
 * would be noise — but slow ones carry the "where did this turn's time go"
 * signal into scrollback.
 */
const SLOW_TOOL_MS = 2000;

/** Format a tool duration for display: `2.4s` under a minute, `1m 12s` above. */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m ${s}s`;
}

/**
 * Duration fragment with magnitude color-grading: dim under 10s, yellow to a
 * minute, red beyond. The thresholds are terminal-scale, not SLA-scale — the
 * point is that the ONE slow call pops out of a wall of green ✓ rows without
 * the reader parsing every number.
 */
function DurationFragment({ ms }: { ms: number }): React.ReactElement {
	const color = ms >= 60_000 ? "red" : ms >= 10_000 ? "yellow" : undefined;
	return color ? (
		<Text color={color}> · {formatDuration(ms)}</Text>
	) : (
		<Text dimColor> · {formatDuration(ms)}</Text>
	);
}

/**
 * Human names for conventional shell exit codes. `exit 127` is trivia;
 * `exit 127 (not found)` is diagnosis. Covers the POSIX shell conventions
 * (126/127/2), GNU timeout (124), and the 128+n killed-by-signal family for
 * the signals that actually show up in tool output (INT/KILL/SEGV/TERM).
 * Returns null for everything else — an unmapped code renders bare rather
 * than with a guessed name.
 */
function exitCodeHint(code: number): string | null {
	switch (code) {
		case 2:
			return "usage error";
		case 124:
			return "timeout";
		case 126:
			return "not executable";
		case 127:
			return "not found";
		case 130:
			return "interrupted";
		case 137:
			return "killed";
		case 139:
			return "segfault";
		case 143:
			return "terminated";
		default:
			return null;
	}
}

/** Summarize tool arguments for display, showing the most relevant arg value IN FULL.
 * Rendered args are never character-capped: the ⏵ row's Text wraps inside the stripe,
 * so a long command renders complete across rows instead of vanishing behind `...` —
 * a truncated command line hides exactly the part that distinguishes this call from
 * the last one. Also used by ChatView for the in-flight tool cards, where the CARD
 * (not this summary) truncates to one line to respect the live viewport budget. */
export function summarizeToolArgs(toolName: string, input: Record<string, unknown>): string {
	// For common tools, show the primary argument. The shell tool is named for
	// its shell (boundless_bash / _pwsh / _cmd via resolveShell), so match the
	// canonical predicate, not a bare `_bash` suffix — which missed PowerShell
	// and cmd.exe. The extra `_bash` suffix keeps the VFS sandbox shell
	// (bms_bash), which the predicate's `boundless_`-anchor doesn't cover.
	if (
		(isShellToolName(toolName) || toolName.endsWith("_bash")) &&
		typeof input.command === "string"
	) {
		return expandTabs(input.command);
	}
	// File tools summarize as their file. Two gauges: boundless_* tools carry
	// `file_path`, the sandbox bms_* tools carry `path`. Without the second,
	// bms_edit/bms_write fall through to the generic branch and dump their
	// full edits/content JSON as the "summary".
	if (toolName.endsWith("_read") || toolName.endsWith("_write") || toolName.endsWith("_edit")) {
		if (typeof input.file_path === "string") return tildifyPath(input.file_path);
		if (typeof input.path === "string") return tildifyPath(input.path);
	}
	// For MCP/other tools, show every arg as key=value, values in full.
	const entries = Object.entries(input);
	if (entries.length === 0) return "";
	return expandTabs(
		entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" "),
	);
}

/** Shape of one hashline edit as carried in `boundless_edit` args. */
type HashlineEditArg = { start: string; end: string; content: string };

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

/**
 * Render the body of a hashline `boundless_edit` tool call. Each edit shows
 * a removal header (`− 12:a3f1 → 14:9c8a · 3 lines`) followed by the
 * replacement lines as green adds. The removed TEXT isn't in the args by
 * design — hashline edits reference anchors instead of reproducing prior
 * content — but the anchors encode the removed SPAN, so the header wears the
 * red minus and the line count explicitly. That keeps the preview visually
 * consistent with the result row's `+N −M` stat: every − the stat claims has
 * a visible source line here. Hard-capped at EDIT_DIFF_MAX_LINES lines total.
 */
function HashlineEditsBody({
	edits,
	filePath,
}: {
	edits: HashlineEditArg[];
	filePath?: string | null;
}): React.ReactElement | null {
	if (edits.length === 0) return null;
	const lang = langFromPath(filePath);

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
		// Removed-span line count from the anchors (parseInt stops at ':').
		const startLine = Number.parseInt(edit.start, 10);
		const endLine = Number.parseInt(edit.end, 10);
		const removedCount =
			Number.isFinite(startLine) && Number.isFinite(endLine)
				? Math.max(0, endLine - startLine + 1)
				: null;
		rows.push(
			<Text key={`h${ei}`}>
				<Text color="red">− </Text>
				<Text dimColor>
					{range}
					{removedCount != null
						? ` · ${removedCount} ${removedCount === 1 ? "line" : "lines"}`
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
				<Text key={`l${ei}-${li}`}>
					<Text color="green">+ </Text>
					<HighlightedLine line={contentLines[li]} lang={lang} color="green" />
				</Text>,
			);
		}
	}

	return (
		<Box flexDirection="column" paddingLeft={2}>
			{rows}
			{truncatedLines > 0 && (
				<Text dimColor>
					⋯ {truncatedLines} more {truncatedLines === 1 ? "line" : "lines"}
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
	const lines = expandTabs(content).split("\n");
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
	cwd,
}: {
	block: { name: string; input: Record<string, unknown> };
	cwd?: string;
}): React.ReactElement {
	const isRemote = !block.name.startsWith("boundless_");
	const name = displayToolName(block.name);
	const filePath = typeof block.input.file_path === "string" ? block.input.file_path : null;
	// `displayPath` is the tildified version for header rendering; we keep the
	// original `filePath` for HashlineEditsBody / WritePreviewBody, which use it for
	// syntax-highlighting language detection. `linkedPath` wraps the display
	// label in an OSC 8 file:// hyperlink so it's clickable in supporting terminals.
	const displayPath = filePath ? tildifyPath(filePath) : null;
	const linkedPath = displayPath ? linkifyPath(displayPath, filePath, cwd) : null;

	// boundless_edit: header + per-edit anchor ranges with added-line previews
	if (block.name === "boundless_edit" && filePath) {
		const edits = asHashlineEdits(block.input.edits);
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="cyan">⏵ </Text>
					<Text color="cyan" bold>
						{name}
					</Text>
					<Text dimColor> {linkedPath}</Text>
				</Text>
				<HashlineEditsBody edits={edits} filePath={filePath} />
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
						{linkedPath} · {lineCount} {lineCount === 1 ? "line" : "lines"}
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
}

/**
 * Renders a message based on its role and content.
 * - `"user"`: green left-stripe, "you" header, content
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
			return <Markdown text={stripTerminalControlSequences(content)} />;
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
			parts.push(<Markdown key={`t-${key++}`} text={textRun.join("\n\n")} />);
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
							<GraphicsImage escape={graphics.escape} rows={graphics.rows} />
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
		// Optimistic placeholder (#88): the user's message is echoed locally
		// before the server persists + broadcasts it. Render dimmed with a
		// "sending…" cue so it reads as in-flight, not yet committed.
		const isPending = message.id === PENDING_USER_MESSAGE_ID;
		return (
			<StripeBox color={isPending ? "gray" : "green"} width={stripeWidth}>
				<Text bold color={isPending ? "gray" : "green"}>
					you{isPending ? <Text dimColor> · sending…</Text> : null}
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
		return (
			<StripeBox color="cyan" width={stripeWidth}>
				<Text>
					<Text bold color="cyan">
						agent
					</Text>
					{activitySummary ? <Text dimColor> · {activitySummary}</Text> : null}
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
			toolUses.length > 1 ? [] : toolUses.filter((b) => !isCompactToolName(b.name));

		if (toolUses.length > 0) {
			return (
				<StripeBox color="cyan" width={stripeWidth}>
					{inlineText && (
						<Box flexDirection="column" marginBottom={toolUseBlocks.length > 0 ? 1 : 0}>
							<Text bold color="cyan">
								agent
							</Text>
							<Markdown text={inlineText} />
						</Box>
					)}
					{toolUseBlocks.map((block, idx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: tool_use blocks are immutable per render
						<ToolCallRow key={idx} block={block} cwd={cwd} />
					))}
				</StripeBox>
			);
		}

		return (
			<StripeBox color="cyan" width={stripeWidth}>
				<Text>
					<Text color="cyan">⏵ </Text>
					<Text color="cyan" bold>
						{displayToolName(message.tool_name || "tool")}
					</Text>
					<Text dimColor>: {stripTerminalControlSequences(message.content)}</Text>
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
		const fullText = stripTerminalControlSequences(
			typeof filteredContent === "string"
				? filteredContent
				: filteredContent
						.filter((b) => b.type === "text")
						.map((b) => (b as { type: "text"; text: string }).text)
						.join("\n"),
		);
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
		// Render the tool NAME resolved upstream (e.g. "read"), never
		// `message.tool_name` — on tool_result rows that column holds the opaque
		// tool_use_id, which is noise in the TUI. When the name can't be resolved
		// (orphan result), show no label rather than echo the id.
		const toolName = resolvedToolName ? displayToolName(resolvedToolName) : null;

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

		// Compact read/search results render as ONE line per invocation: the ⏵
		// call row was suppressed upstream, so this line is the invocation's
		// whole committed footprint — target plus a volume summary (lines read /
		// matches found) instead of a body preview. Errors skip this branch and
		// keep the full rendering below so failures stay visible.
		if (resolvedToolName && isCompactToolName(resolvedToolName) && !isError) {
			const isSearch = resolvedToolName.endsWith("_search");
			const lineCount = `${allLines.length} ${allLines.length === 1 ? "line" : "lines"}`;
			const target = isSearch
				? typeof toolInput?.pattern === "string"
					? toolInput.pattern
					: tildifyText(allLines[0] ?? "")
				: filePath
					? tildifyPath(filePath)
					: tildifyText(allLines[0] ?? "");
			// Read targets are file paths → clickable file:// links. Search targets
			// are patterns, not paths, so they stay plain text.
			const linkedTarget = !isSearch && filePath ? linkifyPath(target, filePath, cwd) : target;
			const summary = isSearch
				? (parseSearchSummary(allLines[allLines.length - 1] ?? "") ?? lineCount)
				: lineCount;
			return (
				<StripeBox color="cyan" width={stripeWidth}>
					{/* No paddingLeft: this line IS the invocation (the ⏵ call row
					    was suppressed), so it sits at ⏵-column depth — indenting it
					    like a result body made it read as an orphaned extra result
					    of whatever call rendered above it. */}
					<Box>
						<Text wrap="wrap">
							<Text color={indicatorColor} bold>
								{indicator}
							</Text>
							<Text color="cyan" bold>
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
			(resolvedToolName.endsWith("_edit") || resolvedToolName.endsWith("_write")) &&
			!isError
		) {
			const isEdit = resolvedToolName.endsWith("_edit");
			const editCount = Array.isArray(toolInput?.edits) ? toolInput.edits.length : null;
			// Hashline anchors already encode the replaced span (`start: "12:aaaa",
			// end: "14:bbbb"` = 3 lines out) and content encodes the lines in — so
			// a real ±diff stat is computable from the args alone, no result
			// parsing. Anchor line numbers parse leniently (parseInt stops at ':').
			const hashEdits = isEdit ? asHashlineEdits(toolInput?.edits) : [];
			let diffStat: { added: number; removed: number } | null = null;
			if (hashEdits.length > 0) {
				let added = 0;
				let removed = 0;
				for (const e of hashEdits) {
					added += e.content === "" ? 0 : e.content.split("\n").length;
					const s = Number.parseInt(e.start, 10);
					const t = Number.parseInt(e.end, 10);
					if (Number.isFinite(s) && Number.isFinite(t)) removed += Math.max(0, t - s + 1);
				}
				diffStat = { added, removed };
			}
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
				<StripeBox color="cyan" width={stripeWidth}>
					{/* Parallel groups: the call's listing is suppressed, so the
					    diff/preview rides here with the request row — without it the
					    change content would never commit at all. */}
					{showRequest && (
						<ToolCallRow block={{ name: resolvedToolName, input: toolInput ?? {} }} cwd={cwd} />
					)}
					<Box paddingLeft={2}>
						<Text wrap="wrap">
							<Text color={indicatorColor} bold>
								{indicator}
							</Text>
							<Text dimColor> {toolName} · </Text>
							<Text>{linkedTarget}</Text>
							<Text dimColor> · {summary}</Text>
							{diffStat ? (
								<>
									<Text dimColor> · </Text>
									<Text color="green">+{diffStat.added}</Text>
									<Text color="red"> −{diffStat.removed}</Text>
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
			<StripeBox color="cyan" width={stripeWidth}>
				{/* Parallel-group results re-render their ⏵ request row here so
				    each result immediately follows its request — the call row's
				    own listing is suppressed because <Static> commits it before
				    any result exists and can never reorder it afterward. */}
				{showRequest && resolvedToolName && (
					<ToolCallRow block={{ name: resolvedToolName, input: toolInput ?? {} }} cwd={cwd} />
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
							<Text color="red">
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
			<StripeBox color="red" width={stripeWidth}>
				<Text bold color="red">
					alert
				</Text>
				<Text color="red">
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
			<StripeBox color="yellow" width={stripeWidth}>
				<Text bold color="yellow">
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
