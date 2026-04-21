import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Box } from "ink";
import type React from "react";
import { useCallback, useEffect, useReducer, useState } from "react";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import type { ToolHandler } from "../tools/types";
import { useCancelHandler } from "./hooks/useCancelHandler";
import { useMcpServers } from "./hooks/useMcpServers";
import { useMessages } from "./hooks/useMessages";
import { useToolCalls } from "./hooks/useToolCalls";
import { ChatView } from "./views/ChatView";
import { McpView } from "./views/McpView";
import { PickerView } from "./views/PickerView";

export type AppView = "chat" | "mcp" | "picker";
export type PickerMode = "thread" | "model";

export interface AppState {
	view: AppView;
	pickerMode?: PickerMode;
	threadId: string;
	model: string | null;
	degraded: boolean;
	bannerMessage: string | null;
	bannerType: "error" | "info" | null;
}

type AppAction =
	| { type: "SET_VIEW"; view: AppView; pickerMode?: PickerMode }
	| { type: "SET_THREAD"; threadId: string }
	| { type: "SET_MODEL"; model: string }
	| { type: "SET_BANNER"; message: string | null; bannerType: "error" | "info" | null }
	| { type: "DISMISS_BANNER" }
	| { type: "SET_DEGRADED"; degraded: boolean };

function appReducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "SET_VIEW":
			return { ...state, view: action.view, pickerMode: action.pickerMode };
		case "SET_THREAD":
			return { ...state, threadId: action.threadId, view: "chat" };
		case "SET_MODEL":
			return { ...state, model: action.model };
		case "SET_BANNER":
			return { ...state, bannerMessage: action.message, bannerType: action.bannerType };
		case "DISMISS_BANNER":
			return { ...state, bannerMessage: null, bannerType: null };
		case "SET_DEGRADED":
			return { ...state, degraded: action.degraded };
		default:
			return state;
	}
}

export interface AppProps {
	client: BoundClient | null;
	threadId: string;
	configDir: string;
	cwd: string;
	hostname: string;
	mcpManager: McpServerManager;
	mcpConfigs: McpServerConfig[];
	logger: AppLogger;
	initialMessages: Message[];
	model: string | null;
	toolHandlers: Map<string, ToolHandler>;
}

/**
 * App: Root TUI component with state management and Ctrl-C integration.
 *
 * Composes all hooks and views, implements CancelStateMachine for Ctrl-C handling.
 * Routes views based on current mode (chat/mcp/picker).
 */
export function App({
	client,
	threadId: initialThreadId,
	configDir: _configDir,
	cwd,
	hostname,
	mcpManager,
	mcpConfigs,
	logger: _logger,
	initialMessages,
	model: initialModel,
	toolHandlers,
}: AppProps): React.ReactElement {
	const [state, dispatch] = useReducer(appReducer, {
		view: "chat",
		threadId: initialThreadId,
		model: initialModel,
		degraded: false,
		bannerMessage: null,
		bannerType: null,
	});

	// Wire in React hooks for state management
	// biome-ignore lint/correctness/noUnusedVariables: appendMessage is managed by the hook and exposed for future use
	const { messages, appendMessage, clearMessages } = useMessages(client, initialMessages);
	const { inFlightTools, abortAll } = useToolCalls(client, toolHandlers, hostname, cwd);
	const { runningCount: mcpServerCount } = useMcpServers(mcpManager);

	// Ctrl-C hint state
	const [ctrlCHint, setCtrlCHint] = useState<string | null>(null);

	const dismissModal = useCallback(() => {
		if (state.view !== "chat") {
			dispatch({ type: "SET_VIEW", view: "chat" });
			return true;
		}
		return false;
	}, [state.view]);

	const showHint = useCallback((message: string) => {
		setCtrlCHint(message);
		setTimeout(() => setCtrlCHint(null), 2000);
	}, []);

	// Ctrl-C handling via CancelStateMachine
	const { stateMachine } = useCancelHandler({
		client,
		threadId: state.threadId,
		abortAll,
		dismissModal,
		showHint,
	});

	// Keep modal state in sync
	stateMachine.modalOpen = state.view !== "chat";

	// Track whether the agent loop is processing (for thinking indicator)
	const [isProcessing, setIsProcessing] = useState(false);
	useEffect(() => {
		if (!client) return;
		const handler = (data: { thread_id: string; active: boolean }) => {
			if (data.thread_id === state.threadId) {
				setIsProcessing(data.active);
			}
		};
		client.on("thread:status", handler);
		return () => {
			client.off("thread:status", handler);
		};
	}, [client, state.threadId]);

	// Dispatch helpers
	const handleSetView = (view: AppView, pickerMode?: PickerMode) => {
		dispatch({ type: "SET_VIEW", view, pickerMode });
	};

	const handleSetThread = (threadId: string) => {
		dispatch({ type: "SET_THREAD", threadId });
	};

	const handleSetModel = (model: string) => {
		dispatch({ type: "SET_MODEL", model });
	};

	const handleSetBanner = (message: string | null, bannerType: "error" | "info" | null) => {
		dispatch({ type: "SET_BANNER", message, bannerType });
	};

	const handleDismissBanner = () => {
		dispatch({ type: "DISMISS_BANNER" });
	};

	const handleClear = useCallback(async () => {
		if (!client) return;
		try {
			const thread = await client.createThread();
			clearMessages();
			dispatch({ type: "SET_THREAD", threadId: thread.id });
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			dispatch({
				type: "SET_BANNER",
				message: `Failed to create new thread: ${errorMsg}`,
				bannerType: "error",
			});
		}
	}, [client, clearMessages]);

	const handleSendMessage = async (message: string) => {
		if (client) {
			try {
				await client.sendMessage(state.threadId, message, { modelId: state.model || undefined });
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				handleSetBanner(`Failed to send message: ${errorMsg}`, "error");
			}
		}
	};

	// View routing
	return (
		<Box flexDirection="column">
			{state.view === "chat" && (
				<ChatView
					client={client}
					threadId={state.threadId}
					model={state.model}
					connectionState={client ? "connected" : "disconnected"}
					messages={messages}
					inFlightTools={inFlightTools}
					mcpServerCount={mcpServerCount}
					bannerMessage={state.bannerMessage}
					bannerType={state.bannerType}
					ctrlCHint={ctrlCHint}
					isProcessing={isProcessing}
					onModelChange={handleSetModel}
					onAttachThread={() => handleSetView("picker", "thread")}
					onMcpView={() => handleSetView("mcp")}
					onClear={handleClear}
					onBannerDismiss={handleDismissBanner}
					onSendMessage={handleSendMessage}
				/>
			)}
			{state.view === "mcp" && (
				<McpView
					mcpManager={mcpManager}
					mcpConfigs={mcpConfigs}
					onConfigChange={() => {
						/* hot-reload handled inside McpView */
					}}
					onCancel={() => handleSetView("chat")}
				/>
			)}
			{state.view === "picker" && state.pickerMode && (
				<PickerView
					mode={state.pickerMode}
					client={client}
					onSelect={(value) => {
						if (state.pickerMode === "thread") {
							handleSetThread(value);
						} else if (state.pickerMode === "model") {
							handleSetModel(value);
						}
					}}
					onCancel={() => handleSetView("chat")}
				/>
			)}
		</Box>
	);
}
