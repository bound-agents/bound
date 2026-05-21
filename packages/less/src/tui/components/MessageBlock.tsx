import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { Markdown } from "./Markdown";

const TOOL_RESULT_MAX_LINES = 5;

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
					{toolUseBlocks.map((block, idx) => {
						const argSummary = summarizeToolArgs(block.name, block.input);
						// Tools not prefixed with "boundless_" are server-side (remote)
						const isRemote = !block.name.startsWith("boundless_");
						const name = displayToolName(block.name);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: tool_use blocks are immutable
							<Text key={idx}>
								<Text color="cyan">⏵ </Text>
								{isRemote && <Text dimColor>[remote] </Text>}
								<Text color="cyan" bold>
									{name}
								</Text>
								{argSummary ? <Text dimColor> {argSummary}</Text> : null}
							</Text>
						);
					})}
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
