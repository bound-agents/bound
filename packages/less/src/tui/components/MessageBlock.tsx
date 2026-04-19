import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { Collapsible } from "./Collapsible";

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
		return (
			<Text dimColor>
				Tool: {message.tool_name} {message.content}
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

	// Fallback for other roles
	return (
		<Text dimColor>
			[{message.role}: {message.content}]
		</Text>
	);
}
