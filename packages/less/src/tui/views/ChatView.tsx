import type { BoundClient, ConnectionState } from "@bound/client";
import type { Message } from "@bound/shared";
import { Box, Static, Text, useStdout } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
	ActionBar,
	Banner,
	MessageBlock,
	SessionHeader,
	Spinner,
	StatusBar,
	TextInput,
	ToolCallCard,
	computeStdoutRowBudget,
} from "../components";
import {
	analyzeToolCallContent,
	formatDuration,
	isCompactToolName,
	summarizeToolArgs,
} from "../components/MessageBlock";
import { PENDING_USER_MESSAGE_ID } from "../hooks/useMessages";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { createResizeRedrawHandler } from "../util/resizeRedraw";

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
		try {
			const blocks = JSON.parse(msg.content) as Array<{
				type?: string;
				id?: string;
				name?: string;
				input?: Record<string, unknown>;
			}>;
			if (!Array.isArray(blocks)) continue;
			const uses = blocks.filter(
				(
					b,
				): b is { type: "tool_use"; id: string; name?: string; input?: Record<string, unknown> } =>
					b.type === "tool_use" && typeof b.id === "string",
			);
			for (const block of uses) {
				// boundless_* file tools carry `file_path`; the sandbox bms_* tools
				// carry `path`. Missing this made a bms_read compact line dump its
				// first hashline as the "target" instead of the file.
				const filePath =
					typeof block.input?.file_path === "string"
						? block.input.file_path
						: typeof block.input?.path === "string"
							? block.input.path
							: undefined;
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
		} catch {
			// Non-parseable content — skip; not all tool_call messages parse cleanly.
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
 * transcript currently ends inside a compact read/search run (the dynamic
 * area below adds its own top gap in that case, since the run's rows carry
 * no bottom margin).
 *
 * Compact tools (read/search) collapse to one line per invocation and
 * consecutive invocations stack with no blank line between them — they
 * dominate coding sessions, so the transcript stays scannable. Because
 * Ink's <Static> commits each row exactly once and never repaints it, a
 * row's margins may depend only on messages that precede it (its own
 * suppressed call, the prior compact run) — never on what arrives later.
 * That is why grouping is expressed as marginTop on the FOLLOWING row
 * ("am I continuing a run?") rather than marginBottom on the last row of a
 * run ("is anything after me?"), which would need the future.
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

/**
 * Discriminated-union item for the session-log Static.
 *
 * Ink's <Static> officially supports only one instance per render tree, so we
 * can't render the splash header in a separate Static above the message log.
 * Instead, we prepend a stable splash sentinel to the messages array; the
 * children renderer discriminates on `kind` and dispatches to the right
 * component. Static tracks its high-water mark internally and only renders
 * items at indices >= that mark, so the sentinel commits exactly once at
 * session start and the messages append in order behind it.
 */
type SplashItem = { kind: "splash" };
type MessageItem = { kind: "message"; msg: Message };
type StaticItem = SplashItem | MessageItem;

/**
 * Module-scoped sentinel so its identity is stable across renders. The Static
 * high-water-mark contract doesn't actually require this (items < mark aren't
 * re-rendered regardless of identity), but a stable reference is the cheapest
 * way to make the invariant obvious to anyone reading the file.
 */
const SPLASH_ITEM: SplashItem = { kind: "splash" };

/**
 * Split the message list into the committed history (everything Ink's <Static>
 * may safely render once and forget) and the single optimistic "sending…"
 * placeholder, if present.
 *
 * #134: the placeholder MUST NOT enter the <Static> stream. <Static> commits
 * each index exactly once and never repaints it, so the in-place reconciliation
 * in useMessages (placeholder → real message at the same array slot) updates the
 * data model but leaves the grey line frozen in the terminal's scrollback. By
 * keeping the placeholder out of `committed` and rendering it in the redrawn
 * dynamic area instead, the reconciliation removes it cleanly and the real user
 * message lands at a fresh Static index that renders correctly. Only one send is
 * ever in flight in boundless, so there is at most one placeholder.
 */
export function partitionPendingMessage(messages: Message[]): {
	committed: Message[];
	pending: Message | null;
} {
	const pending = messages.find((m) => m.id === PENDING_USER_MESSAGE_ID) ?? null;
	const committed = pending ? messages.filter((m) => m.id !== PENDING_USER_MESSAGE_ID) : messages;
	return { committed, pending };
}

export interface ChatViewProps {
	client: BoundClient | null;
	threadId: string;
	model: string | null;
	connectionState: ConnectionState;
	cwd: string;
	/**
	 * Short git SHA of the running build, surfaced in the session-log splash
	 * header. Plumbed from boundless.tsx → App → here so the header renders
	 * once at the top of <Static> and scrolls into the terminal's native
	 * scrollback alongside the rest of the session log.
	 */
	commitHash: string;
	messages: Message[];
	inFlightTools: Map<
		string,
		{ toolName: string; startTime: number; stdout?: string; args?: Record<string, unknown> }
	>;
	mcpServerCount: number;
	bannerMessage: string | null;
	bannerType: "error" | "info" | null;
	ctrlCHint: string | null;
	isProcessing: boolean;
	onModelChange: (model: string) => void;
	onModelPicker: () => void;
	onAttachThread: () => void;
	onMcpView: () => void;
	/** Open the full-fidelity transcript inspector (`/inspect`). */
	onInspect: () => void;
	onClear: () => void;
	onBannerDismiss: () => void;
	onSendMessage: (message: string) => void;
	/**
	 * When false, the dynamic interactive area (input, status bar, action bar,
	 * banners) is suppressed while `<Static>` remains mounted. This preserves
	 * the Static high-water mark across view transitions (e.g. opening the
	 * model/thread picker) so the splash header does not re-render on return.
	 * Defaults to true.
	 */
	active?: boolean;
}

/**
 * ChatView: Main conversation view with message history, text input, and status bar.
 *
 * Uses Ink's <Static> component to render messages into the terminal's native
 * scrollback buffer. Messages are written once and never redrawn, so native
 * terminal scroll and text selection work naturally. The dynamic area below
 * (input, status, tool cards) is redrawn by Ink as needed.
 */
export function ChatView({
	client: _client,
	threadId,
	model,
	connectionState,
	cwd,
	commitHash,
	messages,
	inFlightTools,
	mcpServerCount,
	bannerMessage,
	bannerType,
	ctrlCHint,
	isProcessing,
	onModelChange,
	onModelPicker,
	onAttachThread,
	onMcpView,
	onInspect,
	onClear,
	onBannerDismiss,
	onSendMessage,
	active = true,
}: ChatViewProps): React.ReactElement {
	const [commandError, setCommandError] = useState<string | null>(null);
	const [showHelp, setShowHelp] = useState(false);
	const { columns: termColumns, rows: termRows } = useTerminalSize();
	const { stdout } = useStdout();
	// Repaint nonce: bumped on a width change to force <Static> to remount and
	// re-emit every committed item at the new width. See resizeRedraw.ts for the
	// full rationale (log-update erases the stale frame by logical line count, so
	// a narrower terminal strands the top of the old input box as junk).
	const [redrawNonce, setRedrawNonce] = useState(0);
	useEffect(() => {
		if (!stdout) return;
		const handler = createResizeRedrawHandler({
			initialColumns: (stdout as { columns?: number }).columns ?? 80,
			write: (data) => stdout.write(data),
			redraw: () => setRedrawNonce((n) => n + 1),
		});
		const onResize = () => handler.onResize((stdout as { columns?: number }).columns ?? 80);
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
			handler.dispose();
		};
	}, [stdout]);
	// Per-tool_result metadata (file_path for syntax highlighting +
	// isLastInGroup for parallel-call group margin collapsing). Memoized
	// over the messages array so we walk it only when new messages arrive,
	// keeping per-frame cost flat as scrollback grows.
	const toolResultMeta = useMemo(() => buildToolResultMetaMap(messages), [messages]);

	// Per-assistant-message activity summaries (`14 tools · 1m 40s`), rendered
	// dim after the `agent` header. Same memoization rationale as the meta map.
	const turnActivity = useMemo(() => buildTurnActivityMap(messages), [messages]);

	// Split off the optimistic "sending…" placeholder: it renders in the
	// dynamic area below, NOT in <Static>. See partitionPendingMessage / #134.
	const { committed, pending } = useMemo(() => partitionPendingMessage(messages), [messages]);

	// Per-message layout margins (compact read/search grouping) plus whether
	// the transcript currently ends inside a compact run — the dynamic area
	// below supplies the separating gap in that case, since compact rows
	// carry no bottom margin of their own.
	const layout = useMemo(
		() => buildTranscriptMargins(committed, toolResultMeta),
		[committed, toolResultMeta],
	);

	// Static items: discriminated union of [splash header sentinel, ...committed].
	// Ink's <Static> tracks rendered indices internally and only renders items at
	// indices >= its high-water mark on each update. Putting the splash sentinel
	// at index 0 lets it commit once at session start and scroll into the
	// terminal's native scrollback alongside the message log, exactly matching
	// the desired behavior. Committed messages always append at the tail, so the
	// appended-only invariant holds. The pending placeholder is deliberately
	// excluded — Static can never repaint an in-place reconciliation (#134).
	const staticItems = useMemo<StaticItem[]>(
		() => [SPLASH_ITEM, ...committed.map((msg): StaticItem => ({ kind: "message", msg }))],
		[committed],
	);
	// Account for the rounded input frame: 2 cols of border + 2 cols of
	// paddingX={1} + 2 cols of "❯ " prompt = 6 cols of chrome around the
	// input. Off-by-one here makes the explicit \n breaks emitted by
	// TextInput overflow the inner Box by 1 col, which the terminal then
	// soft-wraps — visible as stuttering 1-char overflow rows.
	const inputColumns = Math.max(10, termColumns - 6);
	// Frame color tracks connection health so the most-looked-at part of the
	// UI surfaces session state without the user having to scan the status bar.
	const frameColor =
		connectionState === "connected"
			? "cyan"
			: connectionState === "disconnected"
				? "red"
				: "yellow";

	// A dismissable banner captures 'x' to close (see Banner). While one is
	// mounted it must steal focus from the chat input — ink broadcasts every
	// keypress to all active handlers, so without this the dismiss 'x' lands in
	// the banner AND as a literal character in the input. Both the connection/
	// info/error banner and the slash-command error banner are dismissable.
	const overlayCapturingInput =
		(bannerMessage != null && bannerType != null) || commandError != null;

	/**
	 * Parse and handle slash commands.
	 */
	const handleSubmit = async (input: string) => {
		setCommandError(null);
		setShowHelp(false);

		if (input.startsWith("/")) {
			const parts = input.slice(1).split(" ");
			const command = parts[0];
			const args = parts.slice(1).join(" ");

			if (command === "help") {
				setShowHelp(true);
				return;
			}

			if (command === "model") {
				if (args) {
					onModelChange(args);
				} else {
					onModelPicker();
				}
				return;
			}

			if (command === "attach") {
				onAttachThread();
				return;
			}

			if (command === "mcp") {
				onMcpView();
				return;
			}

			if (command === "inspect") {
				onInspect();
				return;
			}

			if (command === "clear") {
				onClear();
				return;
			}

			setCommandError(`Unknown command: /${command}`);
			return;
		}

		onSendMessage(input);
	};

	return (
		<Box flexDirection="column">
			{/* Wrap <Static> in a zero-height Box to prevent Ink's Yoga layout
			    bug where the absolute-positioned Static node's height leaks
			    into the root output grid, creating a blank gap between the
			    scrollback messages and the dynamic input area. */}
			<Box height={0}>
				<Static key={redrawNonce} items={staticItems}>
					{(item) => {
						if (item.kind === "splash") {
							return (
								<Box key="splash" marginBottom={1}>
									<SessionHeader commitHash={commitHash} cwd={cwd} />
								</Box>
							);
						}
						const msg = item.msg;
						const meta = toolResultMeta.get(msg.id);
						// Margins come from buildTranscriptMargins: tool groups render
						// as one continuous cyan card, and compact read/search
						// invocations stack one line each with no gap between them
						// (see that function's contract for the Static-safety rationale).
						const m = layout.margins.get(msg.id) ?? { top: 0, bottom: 1 };
						return (
							<Box key={msg.id} marginTop={m.top} marginBottom={m.bottom}>
								<MessageBlock
									message={msg}
									filePath={meta?.filePath}
									toolName={meta?.toolName}
									toolInput={meta?.input}
									showRequest={meta?.total != null && meta.total > 1}
									callCreatedAt={meta?.callCreatedAt}
									activitySummary={turnActivity.get(msg.id)}
									terminalColumns={termColumns}
									cwd={cwd}
								/>
							</Box>
						);
					}}
				</Static>
			</Box>

			{/* Dynamic area — suppressed when active is false so <Static> stays mounted
			    and its high-water mark is preserved across picker/mcp view transitions,
			    preventing the splash header from re-rendering on return to ChatView. */}
			{active && (
				<>
					{/* A compact read/search run carries no bottom margin (its rows
					    stack); supply the turn-separating gap before the dynamic area. */}
					{layout.endsInCompactRun && <Box height={1} />}
					{/* Banners */}
					{bannerMessage && bannerType && (
						<Box marginBottom={1}>
							<Banner type={bannerType} message={bannerMessage} onDismiss={onBannerDismiss} />
						</Box>
					)}
					{showHelp && (
						<Box flexDirection="column" marginBottom={1}>
							<Text bold>Available commands:</Text>
							{[
								["/help", "Show this help message"],
								["/model [name]", "Switch model (opens picker if no name)"],
								["/attach", "Switch to a different thread"],
								["/mcp", "MCP server configuration"],
								["/inspect", "Browse the transcript at full fidelity"],
								["/clear", "Start a new thread"],
							].map(([cmd, desc]) => (
								<Box key={cmd}>
									<Box width={18}>
										<Text color="cyan">{cmd}</Text>
									</Box>
									<Text>{desc}</Text>
								</Box>
							))}
						</Box>
					)}
					{commandError && (
						<Box marginBottom={1}>
							<Banner type="error" message={commandError} onDismiss={() => setCommandError(null)} />
						</Box>
					)}

					{/* Optimistic "sending…" placeholder. Rendered here in the redrawn
					    dynamic area — NOT in <Static> — so the reconciliation that
					    removes it once the real user message:created arrives actually
					    repaints. See partitionPendingMessage / #134. */}
					{pending && (
						<Box marginBottom={1}>
							<MessageBlock message={pending} terminalColumns={termColumns} cwd={cwd} />
						</Box>
					)}

					{/* In-flight tool calls. The per-card stdout budget is derived from
					    the live terminal height and the number of concurrent tools so
					    the whole dynamic region stays under the viewport — otherwise
					    Ink's `outputHeight >= rows` branch strands the spinner card in
					    scrollback (see computeStdoutRowBudget). */}
					{Array.from(inFlightTools.entries()).map(
						([callId, { toolName, startTime, stdout, args }]) => (
							<Box key={callId} marginBottom={1}>
								<ToolCallCard
									toolName={toolName}
									startTime={startTime}
									stdout={stdout}
									argsSummary={args ? summarizeToolArgs(toolName, args) : undefined}
									terminalColumns={termColumns}
									maxStdoutRows={computeStdoutRowBudget(termRows, inFlightTools.size)}
								/>
							</Box>
						),
					)}

					{/* Processing indicator */}
					{isProcessing && inFlightTools.size === 0 && (
						<Box>
							<Spinner label="Thinking" />
						</Box>
					)}

					{/* Ctrl-C hint */}
					{ctrlCHint && (
						<Box>
							<Text dimColor>{ctrlCHint}</Text>
						</Box>
					)}

					{/* Input area — frame color tracks connection health */}
					<Box borderStyle="round" borderColor={frameColor} paddingX={1} flexDirection="row">
						<Text color={frameColor}>{"❯ "}</Text>
						<Box flexGrow={1} flexShrink={1}>
							<TextInput
								placeholder="Enter message or /help"
								onSubmit={handleSubmit}
								disabled={connectionState !== "connected"}
								columns={inputColumns}
								hasFocus={!overlayCapturingInput}
							/>
						</Box>
					</Box>

					{/* Status bar and action hints */}
					<StatusBar
						threadId={threadId}
						model={model}
						connectionState={connectionState}
						mcpServerCount={mcpServerCount}
						cwd={cwd}
					/>
					<ActionBar
						actions={[
							{ keys: "/model", label: "switch model" },
							{ keys: "/attach", label: "switch thread" },
							{ keys: "/mcp", label: "MCP config" },
							{ keys: "Esc", label: "clear input" },
							{ keys: "Ctrl-C", label: "exit" },
						]}
					/>
				</>
			)}
		</Box>
	);
}
