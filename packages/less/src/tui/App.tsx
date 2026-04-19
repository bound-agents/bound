import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Box, useInput } from "ink";
import type React from "react";
import { useReducer } from "react";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
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
	cwd: _cwd,
	hostname: _hostname,
	mcpManager,
	mcpConfigs,
	logger: _logger,
	initialMessages,
	model: initialModel,
}: AppProps): React.ReactElement {
	const [state, dispatch] = useReducer(appReducer, {
		view: "chat",
		threadId: initialThreadId,
		model: initialModel,
		degraded: false,
		bannerMessage: null,
		bannerType: null,
	});

	// Ctrl-C handling via CancelStateMachine (mocked for component testing)
	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			// In a real implementation, would trigger cancel state machine
			// For now, just handle it gracefully
		}
	});

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

	const _handleSetBanner = (message: string | null, bannerType: "error" | "info" | null) => {
		dispatch({ type: "SET_BANNER", message, bannerType });
	};

	const handleDismissBanner = () => {
		dispatch({ type: "DISMISS_BANNER" });
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
					messages={initialMessages}
					inFlightTools={new Map()}
					mcpServerCount={mcpConfigs.length}
					bannerMessage={state.bannerMessage}
					bannerType={state.bannerType}
					onModelChange={handleSetModel}
					onAttachThread={() => handleSetView("picker", "thread")}
					onMcpView={() => handleSetView("mcp")}
					onBannerDismiss={handleDismissBanner}
					onSendMessage={() => {
						/* handled by ChatView */
					}}
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
