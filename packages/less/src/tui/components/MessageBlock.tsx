import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
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
		return input.file_path;
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
 * call's `old_string`/`new_string` args. Lines are color-coded:
 *   red `- ` for removed, green `+ ` for added, dim `  ` for context.
 * Long unchanged stretches between changes are collapsed via `hunkDiff`,
 * and the whole rendering is hard-capped at EDIT_DIFF_MAX_LINES entries.
 */
function EditDiffBody({
	oldString,
	newString,
}: {
	oldString: string;
	newString: string;
}): React.ReactElement | null {
	const diff = computeLineDiff(oldString, newString);
	const hunked = hunkDiff(diff, EDIT_DIFF_CONTEXT);
	if (hunked.length === 0) {
		return null;
	}

	const truncated = hunked.length > EDIT_DIFF_MAX_LINES;
	const display = truncated ? hunked.slice(0, EDIT_DIFF_MAX_LINES) : hunked;

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
						<Text key={idx} color="red">
							- {entry.text}
						</Text>
					);
				}
				if (entry.kind === "add") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff entries are immutable per render
						<Text key={idx} color="green">
							+ {entry.text}
						</Text>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff entries are immutable per render
					<Text key={idx} dimColor>
						{"  "}
						{entry.text}
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
 * "added" — we show the first N lines in green with a `+ ` prefix to
 * mirror the edit-diff rendering.
 */
function WritePreviewBody({ content }: { content: string }): React.ReactElement | null {
	if (content.length === 0) {
		return null;
	}
	const lines = content.split("\n");
	const truncated = lines.length > WRITE_PREVIEW_MAX_LINES;
	const display = truncated ? lines.slice(0, WRITE_PREVIEW_MAX_LINES) : lines;
	return (
		<Box flexDirection="column" paddingLeft={2}>
			{display.map((line, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: preview lines are immutable per render
				<Text key={idx} color="green">
					+ {line}
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
					<Text dimColor> {filePath}</Text>
				</Text>
				<EditDiffBody oldString={oldString} newString={newString} />
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
						{filePath} · {lineCount} {lineCount === 1 ? "line" : "lines"}
					</Text>
				</Text>
				<WritePreviewBody content={content} />
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
 */
function StripeBox({
	color,
	children,
}: {
	color: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Box
			flexDirection="column"
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
}

/**
 * Renders a message based on its role and content.
 * - `"user"`: green left-stripe, "you" header, content
 * - `"assistant"`: blue left-stripe, "agent" header, content (string or ContentBlock[])
 * - `"tool_call"`: blue stripe (continues assistant turn), `⏵ name args` rows
 * - `"tool_result"`: blue stripe, `✓/✗ name · summary` with truncated body
 * - Pending placeholder: dimmed "Waiting for tool result..." text
 */
export function MessageBlock({ message }: MessageBlockProps): React.ReactElement {
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
			<StripeBox color="green">
				<Text bold color="green">
					you
				</Text>
				{renderContent(parsedContent)}
			</StripeBox>
		);
	}

	if (message.role === "assistant") {
		return (
			<StripeBox color="blue">
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
				<StripeBox color="blue">
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
			<StripeBox color="blue">
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
		const truncated = allLines.length > TOOL_RESULT_MAX_LINES;
		const displayLines = truncated ? allLines.slice(0, TOOL_RESULT_MAX_LINES) : allLines;

		// Echo the tool name on the result line so the parent tool_call is
		// visually re-anchored (especially helpful when results scroll past
		// the call header in long output).
		const isError = message.exit_code != null && message.exit_code !== 0;
		const indicator = isError ? "✗" : "✓";
		const indicatorColor = isError ? "red" : "green";
		const toolName = message.tool_name ? displayToolName(message.tool_name) : null;

		return (
			<StripeBox color="blue">
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
						<Text>{displayLines[0] ?? ""}</Text>
					</Text>
					{displayLines.slice(1).map((line, idx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: result lines are immutable
						<Text key={idx}>
							{"  "}
							{line}
						</Text>
					))}
					{truncated && (
						<Text dimColor>
							{"  "}… {allLines.length - TOOL_RESULT_MAX_LINES} more lines
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
