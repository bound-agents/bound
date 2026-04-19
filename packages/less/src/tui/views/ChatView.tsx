import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Box, Text } from "ink";
import type React from "react";
import { useState } from "react";
import {
	ActionBar,
	Banner,
	MessageBlock,
	ScrollRegion,
	SplitView,
	StatusBar,
	TextInput,
	ToolCallCard,
} from "../components";
import { useTerminalSize } from "../hooks/useTerminalSize";

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
	onModelChange: (model: string) => void;
	onAttachThread: () => void;
	onMcpView: () => void;
	onBannerDismiss: () => void;
	onSendMessage: (message: string) => void;
}

/**
 * ChatView: Main conversation view with message history, text input, and status bar.
 *
 * Implements AC9.1 (message rendering), AC9.8 (slash commands),
 * AC9.9 (message sending), AC9.5 (/model), AC9.6 (/attach), AC9.7 (/mcp)
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
	onModelChange,
	onAttachThread,
	onMcpView,
	onBannerDismiss,
	onSendMessage,
}: ChatViewProps): React.ReactElement {
	const [commandError, setCommandError] = useState<string | null>(null);
	const { rows } = useTerminalSize();

	/**
	 * Parse and handle slash commands.
	 * - `/model <name>`: Set model directly
	 * - `/model`: Open model picker
	 * - `/attach <threadId>`: Trigger thread picker
	 * - `/attach`: Open thread picker
	 * - `/mcp`: Switch to MCP configuration
	 * - `/clear`: Create new thread
	 * - Unknown: Show error
	 */
	const handleSubmit = async (input: string) => {
		setCommandError(null);

		if (input.startsWith("/")) {
			const parts = input.slice(1).split(" ");
			const command = parts[0];
			const args = parts.slice(1).join(" ");

			if (command === "model") {
				if (args) {
					// Set model directly
					onModelChange(args);
				} else {
					// Open model picker (would be handled by App state)
					// TODO: implement model picker
				}
				return;
			}

			if (command === "attach") {
				// Open picker
				onAttachThread();
				return;
			}

			if (command === "mcp") {
				onMcpView();
				return;
			}

			if (command === "clear") {
				// Create new thread (would be handled by App state)
				setCommandError("Not implemented in ChatView");
				return;
			}

			// Unknown command
			setCommandError(`Unknown command: /${command}`);
			return;
		}

		// Regular message
		onSendMessage(input);
	};

	// Reserve space for bottom: input line (2) + status bar (1) + action bar (1) + hint (1 maybe) + margins
	const bottomReserve = 6;
	const scrollHeight = Math.max(5, rows - bottomReserve);

	return (
		<SplitView
			height={rows}
			top={
				<Box flexDirection="column">
					{/* Banner for MCP failures or errors */}
					{bannerMessage && bannerType && (
						<Box marginBottom={1}>
							<Banner type={bannerType} message={bannerMessage} onDismiss={onBannerDismiss} />
						</Box>
					)}

					{/* Command error banner */}
					{commandError && (
						<Box marginBottom={1}>
							<Banner type="error" message={commandError} onDismiss={() => setCommandError(null)} />
						</Box>
					)}

					{/* Message history */}
					<ScrollRegion maxHeight={scrollHeight}>
						<Box flexDirection="column">
							{messages.length === 0 ? (
								<Text dimColor>[No messages yet]</Text>
							) : (
								messages.map((msg) => (
									<Box key={`msg-${msg.id}`} marginBottom={1}>
										<MessageBlock message={msg} />
									</Box>
								))
							)}

							{/* In-flight tool calls */}
							{Array.from(inFlightTools.entries()).map(
								([callId, { toolName, startTime, stdout }]) => (
									<Box key={callId} marginBottom={1}>
										<ToolCallCard toolName={toolName} startTime={startTime} stdout={stdout} />
									</Box>
								),
							)}
						</Box>
					</ScrollRegion>
				</Box>
			}
			bottom={
				<Box flexDirection="column">
					{/* Ctrl-C hint */}
					{ctrlCHint && (
						<Box>
							<Text dimColor>{ctrlCHint}</Text>
						</Box>
					)}

					{/* Input area */}
					<Box marginBottom={1}>
						<Text>{">>> "}</Text>
						<TextInput
							placeholder="Enter message or /help"
							onSubmit={handleSubmit}
							disabled={connectionState !== "connected"}
						/>
					</Box>

					{/* Status bar and action hints */}
					<Box flexDirection="column">
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
				</Box>
			}
		/>
	);
}
