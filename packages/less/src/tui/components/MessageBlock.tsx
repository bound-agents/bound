import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { Collapsible } from "./Collapsible";
import { Markdown } from "./Markdown";

const TOOL_RESULT_MAX_LINES = 5;

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

export interface MessageBlockProps {
	message: Message;
}

/**
 * Renders a message based on its role and content.
 * - `"user"`: Green "You:" prefix + content text
 * - `"assistant"`: Blue "Agent:" prefix + content (handle both string and ContentBlock[])
 * - `"tool_call"`: Dimmed tool invocation with tool name and args summary
 * - `"tool_result"`: Collapsible output with tool name header
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
			<Box flexDirection="column">
				<Text color="green">You:</Text>
				{renderContent(parsedContent)}
			</Box>
		);
	}

	if (message.role === "assistant") {
		return (
			<Box flexDirection="column">
				<Text color="blue">Agent:</Text>
				{renderContent(parsedContent)}
			</Box>
		);
	}

	if (message.role === "tool_call") {
		// Parse tool_use blocks from the content JSON to display them nicely
		let toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }> = [];
		try {
			const blocks = JSON.parse(message.content);
			if (Array.isArray(blocks)) {
				toolUseBlocks = blocks.filter((b: { type?: string }) => b.type === "tool_use");
			}
		} catch {
			// Non-parseable content — fall back to raw display
		}

		if (toolUseBlocks.length > 0) {
			return (
				<Box flexDirection="column">
					{toolUseBlocks.map((block, idx) => {
						const argSummary = summarizeToolArgs(block.name, block.input);
						// Tools not prefixed with "boundless_" are server-side (remote)
						const isRemote = !block.name.startsWith("boundless_");
						const prefix = isRemote ? "[remote] " : "";
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: tool_use blocks are immutable
							<Text key={idx} dimColor>
								{">"} {prefix}
								{block.name}
								{argSummary ? ` ${argSummary}` : ""}
							</Text>
						);
					})}
				</Box>
			);
		}

		return (
			<Text dimColor>
				{">"} {message.tool_name || "tool"}: {message.content}
			</Text>
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
		const displayText = truncated
			? allLines.slice(0, TOOL_RESULT_MAX_LINES).join("\n")
			: allLines.join("\n");

		return (
			<Collapsible header={`Tool Result: ${message.tool_name}`} defaultOpen={true}>
				<Text>{displayText}</Text>
				{truncated && (
					<Text dimColor>... {allLines.length - TOOL_RESULT_MAX_LINES} more lines</Text>
				)}
			</Collapsible>
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
