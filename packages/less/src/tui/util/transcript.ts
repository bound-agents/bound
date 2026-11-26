import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { BOUNDLESS_PROVENANCE_PREFIX } from "../../tools/provenance";
import { parseMessageContent } from "./message-text";
import { tildifyPath } from "./path";
import { stripTerminalControlSequences } from "./terminal-control";
import { classifyTool, isCompactToolName, toolTargetPath } from "./tool-names";
import { expandTabs } from "./wrap";

/** One parsed tool_use block from a tool_call message's content JSON. */
export type ToolUseBlockLite = { name: string; input: Record<string, unknown> };
export type MessageContent = string | ContentBlock[];

/** Hide provenance only when doing so leaves an operator-visible result. */
export function withoutBoundlessProvenance(content: MessageContent): MessageContent {
	if (!Array.isArray(content)) return content;
	const visible = content.filter(
		(block) =>
			block.type !== "text" ||
			!(block as { text: string }).text.startsWith(BOUNDLESS_PROVENANCE_PREFIX),
	);
	return visible.length > 0 ? visible : content;
}

/** Flatten text result blocks and remove terminal control plus exterior blank rows. */
export function textContentLines(content: MessageContent): string[] {
	const text = stripTerminalControlSequences(
		typeof content === "string"
			? content
			: content
					.filter((block) => block.type === "text")
					.map((block) => (block as { text: string }).text)
					.join("\n"),
	);
	const lines = text.split("\n");
	const first = lines.findIndex((line) => line.trim().length > 0);
	if (first < 0) return lines;
	let last = lines.length - 1;
	while (last > first && lines[last].trim().length === 0) last--;
	return lines.slice(first, last + 1);
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
	const blocks = parseMessageContent<{ type?: string; text?: string }>(content);
	if (typeof blocks !== "string") {
		toolUses = blocks.filter((b) => b.type === "tool_use") as unknown as ToolUseBlockLite[];
		inlineText = blocks
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => stripTerminalControlSequences(b.text as string))
			.filter(Boolean)
			.join("\n\n");
	}
	const suppressed =
		toolUses.length > 0 &&
		inlineText === "" &&
		(toolUses.length > 1 ||
			// A lone yard invocation renders as the Yard execution card (live
			// while running, committed at the result row) which now carries the
			// program and input itself — a separate request card above it showed
			// the same payload twice.
			toolUses.every((b) => isCompactToolName(b.name) || classifyTool(b.name) === "yard"));
	return { toolUses, inlineText, suppressed };
}

/**
 * Parse the shared search-result footer ("N matches in M files (K files
 * searched)" / "No matches found (K files searched).") into the compact
 * summary fragment. Returns null when the line isn't the shared footer
 * (an error result or a differently-shaped remote tool) so the caller can
 * fall back to a plain line count.
 */
export function parseSearchSummary(lastLine: string): string | null {
	if (/^No matches found \(\d+ files? searched\)\.?/.test(lastLine)) return "no matches";
	const m = lastLine.match(/^(\d+ match(?:es)? in \d+ files?) \(\d+ files? searched\)/);
	return m ? m[1] : null;
}

/** Summarize the tab-separated table emitted by the read-only `query` tool. */
export function parseQuerySummary(lines: string[]): string {
	const header = lines[0] ?? "";
	if (header.trim() === "") return "no rows";
	const columns = header.split("\t").length;
	const rows = Math.max(0, lines.length - 1);
	const columnLabel = `${columns} ${columns === 1 ? "column" : "columns"}`;
	return rows === 0
		? `no rows · ${columnLabel}`
		: `${rows} ${rows === 1 ? "row" : "rows"} · ${columnLabel}`;
}

/**
 * Threshold for showing a duration fragment on committed result rows. The
 * spinner already shows elapsed time while a tool runs; the committed row
 * used to forget it. Fast calls stay unannotated — a duration on every row
 * would be noise — but slow ones carry the "where did this turn's time go"
 * signal into scrollback.
 */
export const SLOW_TOOL_MS = 2000;

/** Format a tool duration for display: `2.4s` under a minute, `1m 12s` above. */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m ${s}s`;
}

/**
 * Human names for conventional shell exit codes. `exit 127` is trivia;
 * `exit 127 (not found)` is diagnosis. Covers the POSIX shell conventions
 * (126/127/2), GNU timeout (124), and the 128+n killed-by-signal family for
 * the signals that actually show up in tool output (INT/KILL/SEGV/TERM).
 * Returns null for everything else — an unmapped code renders bare rather
 * than with a guessed name.
 */
export function exitCodeHint(code: number): string | null {
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
	const kind = classifyTool(toolName);
	if (kind === "shell" && typeof input.command === "string") return expandTabs(input.command);
	if (kind === "read" || kind === "write" || kind === "edit") {
		const target = toolTargetPath(input);
		if (target !== undefined) return tildifyPath(target);
	}
	// For MCP/other tools, show every arg as key=value, values in full.
	const entries = Object.entries(input);
	if (entries.length === 0) return "";
	return expandTabs(
		entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" "),
	);
}

/**
 * Per-tool_result metadata derived from its originating tool_call:
 * - `filePath`: present when the matching tool_use carried a `file_path`
 *   input — used by MessageBlock for syntax highlighting on read results.
 * - `isLastInGroup`: false when more sibling results from the same parallel
 *   tool_call are still expected; true for the final one. ChatView uses this
 *   to collapse the inter-result gap so a parallel-call group renders as one
 *   continuous cyan-striped card.
 */
export type ToolResultMeta = {
	filePath?: string;
	isLastInGroup: boolean;
	/**
	 * The originating tool_use's `name` (e.g. "boundless_read"), resolved via
	 * the correlation map. MessageBlock renders this on the result line — the
	 * result row's own `tool_name` column holds the opaque tool_use_id, not a
	 * name, so without this the header would echo a useless id.
	 */
	toolName?: string;
	/** The originating tool_use's `input` args — compact result lines render from these. */
	input?: Record<string, unknown>;
	/** id of the owning tool_call message — used for group-continuation margins. */
	callMsgId?: string;
	/**
	 * Number of tool_use blocks in the owning call. Results of PARALLEL groups
	 * (total > 1) re-render their ⏵ request row so each result immediately
	 * follows its request — the call's own listing is suppressed.
	 */
	total?: number;
	/**
	 * `created_at` of the owning tool_call message. Paired with the result's
	 * own `created_at` it yields wall-clock duration for the completed call —
	 * both frozen by the time the result row commits (Static-safe).
	 */
	callCreatedAt?: string;
};

/**
 * Walk messages once to derive per-tool_result metadata.
 *
 * Tool calls and their results are correlated through `tool_use_id`:
 * the call's content is a JSON `[{type: "tool_use", id, name, input}]`,
 * and the result message stores the matching id in its `tool_name`
 * column (a quirk of the storage layer — the column name reads as the
 * tool name but for tool_result rows it's the tool_use_id).
 *
 * The `isLastInGroup` flag is computed using each call's full
 * tool_use count as the denominator and a per-call running counter
 * over results seen so far. Crucially, the denominator is known the
 * moment the call lands — so even before sibling results arrive, an
 * early result can correctly classify itself as `isLastInGroup=false`.
 * That's what makes the visual grouping Static-friendly: each result
 * gets the right margin on first render and never needs to re-render.
 */
export function buildToolResultMetaMap(messages: Message[]): Map<string, ToolResultMeta> {
	// Pass 1: index every tool_use block from every tool_call message.
	// Each entry knows its parent call and the call's total tool_use count.
	const toolUseToInfo = new Map<
		string,
		{
			filePath?: string;
			toolName?: string;
			input?: Record<string, unknown>;
			callMsgId: string;
			total: number;
			callCreatedAt: string;
		}
	>();
	for (const msg of messages) {
		if (msg.role !== "tool_call") continue;
		const blocks = parseMessageContent<{
			type?: string;
			id?: string;
			name?: string;
			input?: Record<string, unknown>;
		}>(msg.content);
		if (typeof blocks === "string") continue;
		{
			const uses = blocks.filter(
				(
					b,
				): b is { type: "tool_use"; id: string; name?: string; input?: Record<string, unknown> } =>
					b.type === "tool_use" && typeof b.id === "string",
			);
			for (const block of uses) {
				const filePath = toolTargetPath(block.input);
				const toolName = typeof block.name === "string" ? block.name : undefined;
				toolUseToInfo.set(block.id, {
					filePath,
					toolName,
					input: block.input,
					callMsgId: msg.id,
					total: uses.length,
					callCreatedAt: msg.created_at,
				});
			}
		}
	}

	// Pass 2: walk results in order. The K-th result for a call (K === total)
	// is the last in its group; everything before that is mid-group.
	const seenPerCall = new Map<string, number>();
	const result = new Map<string, ToolResultMeta>();
	for (const msg of messages) {
		if (msg.role !== "tool_result" || !msg.tool_name) continue;
		const info = toolUseToInfo.get(msg.tool_name);
		if (!info) continue;
		const seen = (seenPerCall.get(info.callMsgId) ?? 0) + 1;
		seenPerCall.set(info.callMsgId, seen);
		result.set(msg.id, {
			filePath: info.filePath,
			isLastInGroup: seen === info.total,
			toolName: info.toolName,
			input: info.input,
			callMsgId: info.callMsgId,
			total: info.total,
			callCreatedAt: info.callCreatedAt,
		});
	}
	return result;
}

/**
 * Per-message layout margins for the session-log Static, plus whether the
 * transcript currently ends inside a compact read/search/query run (the dynamic
 * area below adds its own top gap in that case, since the run's rows carry no
 * bottom margin).
 *
 * Compact tools collapse to one line per invocation and consecutive calls stack
 * with no blank line between them — they dominate coding sessions, so the
 * transcript stays scannable. Because Ink's <Static> commits each row exactly
 * once and never repaints it, a row's margins may depend only on messages that
 * precede it (its own suppressed call, the prior compact run) — never on what
 * arrives later. That is why grouping is expressed as marginTop on the
 * FOLLOWING row ("am I continuing a run?") rather than marginBottom on the last
 * row ("is anything after me?"), which would need the future.
 */
export function buildTranscriptMargins(
	messages: Message[],
	meta: Map<string, ToolResultMeta>,
): { margins: Map<string, { top: number; bottom: number }>; endsInCompactRun: boolean } {
	const margins = new Map<string, { top: number; bottom: number }>();
	// Rolling state over already-committed rows. `compactRun` means the last
	// VISIBLE row is a compact one-liner; `visibleCallMsgId` is the owning
	// call of the last visible tool row. Suppressed (zero-height) calls leave
	// both untouched — they don't change what's on screen, so letting them
	// flip the state would misplace gaps around rows they never rendered.
	let compactRun = false;
	let visibleCallMsgId: string | undefined;
	for (const msg of messages) {
		if (msg.role === "tool_call") {
			const { suppressed } = analyzeToolCallContent(msg.content);
			if (suppressed) {
				// Zero-height row — any margin would render as a stray blank
				// line, and the visible-row state is unaffected.
				margins.set(msg.id, { top: 0, bottom: 0 });
			} else {
				margins.set(msg.id, { top: compactRun ? 1 : 0, bottom: 0 });
				compactRun = false;
				visibleCallMsgId = msg.id;
			}
			continue;
		}
		if (msg.role === "tool_result") {
			const m = meta.get(msg.id);
			const isError = msg.exit_code != null && msg.exit_code !== 0;
			if (m?.toolName != null && isCompactToolName(m.toolName) && !isError) {
				// Compact one-liner: stacks directly onto whatever visible row
				// precedes it (a run sibling, or a full row whose own bottom
				// margin supplies the gap).
				margins.set(msg.id, { top: 0, bottom: 0 });
				compactRun = true;
				visibleCallMsgId = m.callMsgId;
			} else {
				// Full-width result (or ⏵-paired result for parallel groups):
				// abuts the group it visibly continues; takes the separating
				// gap when it interrupts a compact run it doesn't belong to.
				const continuesVisibleGroup = m?.callMsgId != null && m.callMsgId === visibleCallMsgId;
				margins.set(msg.id, {
					top: !continuesVisibleGroup && compactRun ? 1 : 0,
					bottom: m && !m.isLastInGroup ? 0 : 1,
				});
				compactRun = false;
				visibleCallMsgId = m?.callMsgId;
			}
			continue;
		}
		margins.set(msg.id, { top: compactRun ? 1 : 0, bottom: 1 });
		compactRun = false;
		visibleCallMsgId = undefined;
	}
	return { margins, endsInCompactRun: compactRun };
}

/**
 * Minimum activity for an assistant turn-header summary: a couple of quick
 * tool calls aren't a journey worth narrating, but a long run (or a slow one)
 * is — the header tells the reader what the turn cost at the moment they
 * start reading its conclusion.
 */
const ACTIVITY_MIN_TOOLS = 3;
const ACTIVITY_MIN_MS = 10_000;

/**
 * Walk messages once and, for each assistant message that concludes a run of
 * tool activity, produce a one-line summary of that run (`14 tools · 1m 40s`).
 * Rendered dim after the `agent` header by MessageBlock.
 *
 * Static-safe by the same argument as the margin map: a summary depends only
 * on messages that PRECEDE the assistant message it annotates, so the row
 * renders correctly the first time and never needs a repaint. Duration is
 * wall-clock from the run's first tool_call commit to the assistant commit —
 * both timestamps frozen before the assistant row exists.
 */
export function buildTurnActivityMap(messages: Message[]): Map<string, string> {
	const out = new Map<string, string>();
	let toolCount = 0;
	let runStartMs: number | null = null;
	for (const msg of messages) {
		if (msg.role === "tool_call") {
			if (runStartMs === null) runStartMs = Date.parse(msg.created_at);
			continue;
		}
		if (msg.role === "tool_result") {
			toolCount += 1;
			continue;
		}
		if (msg.role === "assistant") {
			if (toolCount > 0 && runStartMs !== null && Number.isFinite(runStartMs)) {
				const ms = Date.parse(msg.created_at) - runStartMs;
				const qualifies =
					toolCount >= ACTIVITY_MIN_TOOLS || (Number.isFinite(ms) && ms >= ACTIVITY_MIN_MS);
				if (qualifies && Number.isFinite(ms) && ms >= 0) {
					out.set(
						msg.id,
						`${toolCount} ${toolCount === 1 ? "tool" : "tools"} · ${formatDuration(ms)}`,
					);
				}
			}
			toolCount = 0;
			runStartMs = null;
			continue;
		}
		// user / system / alert rows break the run: activity before them
		// belongs to a different turn than any assistant message after.
		toolCount = 0;
		runStartMs = null;
	}
	return out;
}
