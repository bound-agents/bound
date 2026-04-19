import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { Collapsible } from "./Collapsible";

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
	// Helper to render content
	const renderContent = (content: string | ContentBlock[]): React.ReactElement => {
		if (typeof content === "string") {
			return <Text>{content}</Text>;
		}

		// ContentBlock array - extract text blocks
		const textBlocks = content.filter((block) => block.type === "text");
		if (textBlocks.length === 0) {
			return <Text dimColor>[Non-text content]</Text>;
		}

		return (
			<Box flexDirection="column">
				{textBlocks.map((block, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: ContentBlocks are immutable and won't reorder
					<Text key={`text-${index}`}>{(block as { type: "text"; text: string }).text}</Text>
				))}
			</Box>
		);
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
			<Box>
				<Text color="green">You: </Text>
				{renderContent(parsedContent)}
			</Box>
		);
	}

	if (message.role === "assistant") {
		return (
			<Box>
				<Text color="blue">Agent: </Text>
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
						// Show the most relevant argument as a summary
						const argSummary = summarizeToolArgs(block.name, block.input);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: tool_use blocks are immutable
							<Text key={idx} dimColor>
								{">"} {block.name}
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
		return (
			<Collapsible header={`Tool Result: ${message.tool_name}`} defaultOpen={true}>
				{renderContent(parsedContent)}
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
