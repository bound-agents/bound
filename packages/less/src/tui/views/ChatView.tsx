import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Box, Static, Text } from "ink";
import type React from "react";
import { useState } from "react";
import {
	ActionBar,
	Banner,
	MessageBlock,
	Spinner,
	StatusBar,
	TextInput,
	ToolCallCard,
} from "../components";

export interface ChatViewProps {
	client: BoundClient | null;
	threadId: string;
	model: string | null;
	connectionState: string;
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
}: ChatViewProps): React.ReactElement {
	const [commandError, setCommandError] = useState<string | null>(null);
	const [showHelp, setShowHelp] = useState(false);

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
				<Static items={messages}>
					{(msg) => (
						<Box key={msg.id} marginBottom={1}>
							<MessageBlock message={msg} />
						</Box>
					)}
				</Static>
			</Box>

			{/* Dynamic area — redrawn by Ink on state changes */}

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
					<ToolCallCard toolName={toolName} startTime={startTime} stdout={stdout} />
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

			{/* Input area */}
			<Box>
				<Text color="cyan">{"❯ "}</Text>
				<Box flexGrow={1} flexShrink={1}>
					<TextInput
						placeholder="Enter message or /help"
						onSubmit={handleSubmit}
						disabled={connectionState !== "connected"}
					/>
				</Box>
			</Box>

			{/* Status bar and action hints */}
			<StatusBar
				threadId={threadId}
				model={model}
				connectionState={connectionState}
				mcpServerCount={mcpServerCount}
			/>
			<ActionBar
				actions={[
					{ keys: "/model", label: "switch model" },
					{ keys: "/attach", label: "switch thread" },
					{ keys: "/mcp", label: "MCP config" },
					{ keys: "Ctrl-C", label: "exit" },
				]}
			/>
		</Box>
	);
}
