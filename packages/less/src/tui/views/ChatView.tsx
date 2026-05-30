import type { BoundClient, ConnectionState } from "@bound/client";
import type { Message } from "@bound/shared";
import { Box, Static, Text } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import {
	ActionBar,
	Banner,
	MessageBlock,
	SessionHeader,
	Spinner,
	StatusBar,
	TextInput,
	ToolCallCard,
} from "../components";
import { useTerminalSize } from "../hooks/useTerminalSize";

/**
 * Per-tool_result metadata derived from its originating tool_call:
 * - `filePath`: present when the matching tool_use carried a `file_path`
 *   input — used by MessageBlock for syntax highlighting on read results.
 * - `isLastInGroup`: false when more sibling results from the same parallel
 *   tool_call are still expected; true for the final one. ChatView uses this
 *   to collapse the inter-result gap so a parallel-call group renders as one
 *   continuous blue-striped card.
 */
export type ToolResultMeta = {
	filePath?: string;
	isLastInGroup: boolean;
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
	const toolUseToInfo = new Map<string, { filePath?: string; callMsgId: string; total: number }>();
	for (const msg of messages) {
		if (msg.role !== "tool_call") continue;
		try {
			const blocks = JSON.parse(msg.content) as Array<{
				type?: string;
				id?: string;
				input?: Record<string, unknown>;
			}>;
			if (!Array.isArray(blocks)) continue;
			const uses = blocks.filter(
				(b): b is { type: "tool_use"; id: string; input?: Record<string, unknown> } =>
					b.type === "tool_use" && typeof b.id === "string",
			);
			for (const block of uses) {
				const filePath =
					typeof block.input?.file_path === "string" ? block.input.file_path : undefined;
				toolUseToInfo.set(block.id, { filePath, callMsgId: msg.id, total: uses.length });
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
		});
	}
	return result;
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
	inFlightTools: Map<string, { toolName: string; startTime: number; stdout?: string }>;
	mcpServerCount: number;
	bannerMessage: string | null;
	bannerType: "error" | "info" | null;
	ctrlCHint: string | null;
	isProcessing: boolean;
	onModelChange: (model: string) => void;
	onModelPicker: () => void;
	onAttachThread: () => void;
	onMcpView: () => void;
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
	onClear,
	onBannerDismiss,
	onSendMessage,
	active = true,
}: ChatViewProps): React.ReactElement {
	const [commandError, setCommandError] = useState<string | null>(null);
	const [showHelp, setShowHelp] = useState(false);
	const { columns: termColumns } = useTerminalSize();
	// Per-tool_result metadata (file_path for syntax highlighting +
	// isLastInGroup for parallel-call group margin collapsing). Memoized
	// over the messages array so we walk it only when new messages arrive,
	// keeping per-frame cost flat as scrollback grows.
	const toolResultMeta = useMemo(() => buildToolResultMetaMap(messages), [messages]);

	// Static items: discriminated union of [splash header sentinel, ...messages].
	// Ink's <Static> tracks rendered indices internally and only renders items at
	// indices >= its high-water mark on each update. Putting the splash sentinel
	// at index 0 lets it commit once at session start and scroll into the
	// terminal's native scrollback alongside the message log, exactly matching
	// the desired behavior. Messages always append at the tail, so the appended-
	// only invariant holds.
	const staticItems = useMemo<StaticItem[]>(
		() => [SPLASH_ITEM, ...messages.map((msg): StaticItem => ({ kind: "message", msg }))],
		[messages],
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
				<Static items={staticItems}>
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
						// Margin rule: collapse the gap inside a tool group so the blue
						// stripe runs continuously through call → results.
						//   - tool_call → next: always 0 (touches its first result, or
						//     in degenerate cases still fine to abut).
						//   - tool_result, mid-group: 0 (touches sibling result).
						//   - tool_result, last in group: 1 (separates from next turn).
						//   - everything else: 1 (default turn-to-turn separation).
						const marginBottom = msg.role === "tool_call" ? 0 : meta && !meta.isLastInGroup ? 0 : 1;
						return (
							<Box key={msg.id} marginBottom={marginBottom}>
								<MessageBlock
									message={msg}
									filePath={meta?.filePath}
									terminalColumns={termColumns}
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

					{/* In-flight tool calls */}
					{Array.from(inFlightTools.entries()).map(([callId, { toolName, startTime, stdout }]) => (
						<Box key={callId} marginBottom={1}>
							<ToolCallCard
								toolName={toolName}
								startTime={startTime}
								stdout={stdout}
								terminalColumns={termColumns}
							/>
						</Box>
					))}

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
							{ keys: "Ctrl-C", label: "exit" },
						]}
					/>
				</>
			)}
		</Box>
	);
}
