import type { BoundClient } from "@bound/client";
import type { ContentBlock } from "@bound/llm";
import type { Message } from "@bound/shared";
import { Box } from "ink";
import type React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import { transitionThread } from "../session/transition";
import { checkSandboxAvailable } from "../tools/sandbox";
import type { ResolvedSandboxConfig } from "../tools/sandbox";
import { SandboxOverrideStore } from "../tools/sandbox-override";
import type { ResolvedShell } from "../tools/shell";
import type { ToolHandler } from "../tools/types";
import { useCancelHandler } from "./hooks/useCancelHandler";
import { useConnectionState } from "./hooks/useConnectionState";
import { useMcpServers } from "./hooks/useMcpServers";
import { useMessages } from "./hooks/useMessages";
import { useToolCalls } from "./hooks/useToolCalls";
import { type ModelCandidate, resolveModelName } from "./util/resolve-model";
import { TerminalTitleController, formatThreadTitleForTerminal } from "./util/terminal-title";
import { ChatView } from "./views/ChatView";
import { InspectorView } from "./views/InspectorView";
import { McpView } from "./views/McpView";
import { PickerView, truncateLabel } from "./views/PickerView";
const NULL_TERMINAL_TITLE = new TerminalTitleController(
	{ isTTY: false, write: () => undefined },
	{ TERM: "dumb" },
);
export type AppView = "chat" | "mcp" | "picker" | "inspector";
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
	/**
	 * Short git SHA of the running build (or "dev" when running from source).
	 * Surfaced in the session-log splash header so the operator can identify
	 * the binary version they're talking to without leaving the TUI.
	 */
	commitHash: string;
	hostname: string;
	mcpManager: McpServerManager;
	mcpConfigs: McpServerConfig[];
	logger: AppLogger;
	initialMessages: Message[];
	model: string | null;
	toolHandlers: Map<string, ToolHandler>;
	/** Initial title fetched during startup, used before the first refresh poll. */
	initialThreadTitle?: string | null;
	/** Terminal title controller owned by boundless.tsx so shutdown can restore it. */
	terminalTitle?: TerminalTitleController;
	/** Context files injected into the system prompt during thread transitions. */
	contextFiles?: string[];
	/** Resolved shell for the bash-family tool (streaming + spawn invocation). */
	shell: ResolvedShell;
	/** Resolved filesystem sandbox policy for the bash-family tool. */
	sandbox: ResolvedSandboxConfig;
	/**
	 * Per-thread sandbox override store (the `/sandbox` TUI command). Session-
	 * scoped, operator-only. The tool-call hook reads it through a thread-pinned
	 * read-only resolver; the `/sandbox` dispatch in ChatView mutates it.
	 */
	sandboxOverrides?: SandboxOverrideStore;
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
	configDir,
	cwd,
	commitHash,
	hostname,
	mcpManager,
	mcpConfigs,
	logger,
	initialMessages,
	model: initialModel,
	toolHandlers,
	initialThreadTitle = null,
	terminalTitle = NULL_TERMINAL_TITLE,
	contextFiles,
	shell,
	sandbox,
	sandboxOverrides: providedSandboxOverrides,
}: AppProps): React.ReactElement {
	// Callers that don't wire the store (tests, embedded renders) get a private
	// session-scoped one, so `/sandbox` still works and the tool path still reads
	// through a resolver.
	const [fallbackSandboxOverrides] = useState(() => new SandboxOverrideStore());
	const sandboxOverrides = providedSandboxOverrides ?? fallbackSandboxOverrides;
	const [state, dispatch] = useReducer(appReducer, {
		view: "chat",
		threadId: initialThreadId,
		model: initialModel,
		degraded: false,
		bannerMessage: null,
		bannerType: null,
	});

	// The viewed thread, read by event handlers that must drop other threads'
	// traffic (aux threads, a thread we just left). Updated during render so a
	// handler never sees a stale id after a switch commits.
	const viewedThreadRef = useRef(state.threadId);
	viewedThreadRef.current = state.threadId;

	// Wire in React hooks for state management
	const {
		messages,
		clearMessages,
		replaceMessages,
		appendPendingUserMessage,
		clearPendingUserMessage,
	} = useMessages(client, initialMessages, viewedThreadRef);
	const { inFlightTools, abortAll } = useToolCalls(
		client,
		toolHandlers,
		hostname,
		cwd,
		shell,
		sandbox,
		// Thread-pinned, read-only resolver: the ONLY sandbox control the tool path
		// sees. It reads the live `/sandbox` override for THIS thread at command
		// time and cannot mutate it (see sandbox-override.ts). Rebuilt when the
		// viewed thread changes so /attach and /clear see the right thread's state.
		useMemo(() => sandboxOverrides.resolverFor(state.threadId), [sandboxOverrides, state.threadId]),
		state.threadId,
	);
	const { runningCount: mcpServerCount } = useMcpServers(mcpManager);
	const connectionState = useConnectionState(client);

	// Ctrl-C hint state
	const [ctrlCHint, setCtrlCHint] = useState<string | null>(null);

	const dismissModal = useCallback(() => {
		if (state.view !== "chat") {
			dispatch({ type: "SET_VIEW", view: "chat" });
			return true;
		}
		return false;
	}, [state.view]);

	const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const showHint = useCallback((message: string) => {
		setCtrlCHint(message);
		if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
		hintTimerRef.current = setTimeout(() => {
			hintTimerRef.current = null;
			setCtrlCHint(null);
		}, 2000);
	}, []);
	useEffect(
		() => () => {
			if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
		},
		[],
	);

	// Ctrl-C handling via CancelStateMachine
	const { stateMachine } = useCancelHandler({
		client,
		threadId: state.threadId,
		abortAll,
		dismissModal,
		showHint,
	});

	// Keep modal state in sync (an effect, not a render-time mutation)
	useEffect(() => {
		stateMachine.modalOpen = state.view !== "chat";
	}, [stateMachine, state.view]);

	// Track whether the agent loop is processing (for thinking indicator)
	const [isProcessing, setIsProcessing] = useState(false);
	useEffect(() => {
		// A new thread starts idle: a spinner from the thread we left (whose
		// inactive status we will never receive now) must not carry over.
		setIsProcessing(false);
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

	// One-time sandbox availability probe, so `/sandbox` can report a passthrough
	// host (mxc/lowbox can't contain here) and explain that `/sandbox allow` has no
	// effect there. The underlying check is memoized per process in the sandbox
	// module; `null` means still settling.
	const [sandboxAvailable, setSandboxAvailable] = useState<boolean | null>(null);
	useEffect(() => {
		let cancelled = false;
		void checkSandboxAvailable()
			.then((r) => {
				if (!cancelled) setSandboxAvailable(r.supported);
			})
			.catch(() => {
				if (!cancelled) setSandboxAvailable(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Logical model id → display name (spec §2.1), fetched once so the status line
	// shows the user-facing name the picker displays, never the internal id. The
	// id itself is the fallback until the fetch lands (or when it has no entry).
	const [modelDisplayNames, setModelDisplayNames] = useState<ReadonlyMap<string, string>>(
		() => new Map(),
	);
	useEffect(() => {
		if (!client) return;
		let cancelled = false;
		// The status line's model can be a logical model id (the picker selects
		// logical models) or a backend id (inherited from a thread hint or a turn's
		// model_id, e.g. `zai-glm-5.3-flash`). `/models` returns one row per logical
		// model, so key by both its backend id and its logical id, then add every
		// route's backend id from the routing API so a backend served on another
		// host still resolves to its model's display name.
		Promise.all([
			client.listModels(),
			// Best-effort: an older server (or a client without the routing API)
			// leaves only the /models names. Deferred so a missing method rejects
			// into the catch instead of throwing synchronously.
			Promise.resolve()
				.then(() => client.getRoutingModels())
				.catch(() => ({
					models: [] as Awaited<ReturnType<typeof client.getRoutingModels>>["models"],
				})),
		])
			.then(([res, routing]) => {
				if (cancelled) return;
				const names = new Map<string, string>();
				for (const m of routing.models) {
					if (!m.display_name) continue;
					names.set(m.logical_model, m.display_name);
					for (const r of m.routes) {
						// RouteId is `${siteId}:${provider}:${backendId}`; the backend id may
						// itself contain colons (e.g. Bedrock `...-v1:0`).
						const backendId = r.route_id.split(":").slice(2).join(":");
						if (backendId && !names.has(backendId)) names.set(backendId, m.display_name);
					}
				}
				for (const m of res.models) {
					const name = m.display_name ?? (m.logical_model && names.get(m.logical_model));
					if (!name) continue;
					if (!names.has(m.id)) names.set(m.id, name);
					if (m.logical_model && !names.has(m.logical_model)) names.set(m.logical_model, name);
				}
				setModelDisplayNames(names);
			})
			.catch(() => {
				// Best-effort: an older server / failed fetch leaves the id showing.
			});
		return () => {
			cancelled = true;
		};
	}, [client]);
	const displayModel = useCallback(
		(id: string) => modelDisplayNames.get(id) ?? id,
		[modelDisplayNames],
	);
	const modelDisplay = state.model ? displayModel(state.model) : null;
	// Banners stay one line: a long display name must not grow the frame past
	// stdout.rows (Ink then full-clears the terminal).
	const bannerModel = (id: string) => truncateLabel(displayModel(id), 40);

	useEffect(() => {
		let cancelled = false;
		let lastTitle = state.threadId === initialThreadId ? initialThreadTitle : null;

		if (lastTitle !== null) {
			terminalTitle.set(formatThreadTitleForTerminal(lastTitle));
		}

		const refreshTitle = async () => {
			if (!client) return;
			try {
				const thread = await client.getThread(state.threadId);
				if (cancelled || thread.title === lastTitle) return;
				lastTitle = thread.title;
				terminalTitle.set(formatThreadTitleForTerminal(thread.title));
			} catch {
				// The terminal title is cosmetic; losing one refresh must not disturb chat.
			}
		};

		void refreshTitle();
		const interval = setInterval(refreshTitle, 15_000);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [client, initialThreadId, initialThreadTitle, state.threadId, terminalTitle]);

	// Dispatch helpers
	const handleSetView = (view: AppView, pickerMode?: PickerMode) => {
		dispatch({ type: "SET_VIEW", view, pickerMode });
	};

	const transitionInFlightRef = useRef(false);
	const handleSetThread = async (threadId: string) => {
		if (!client) return;
		// Re-selecting the current thread just closes the picker.
		if (threadId === state.threadId) {
			dispatch({ type: "SET_VIEW", view: "chat" });
			return;
		}
		// A second Enter during a slow attach must not race a second transition.
		if (transitionInFlightRef.current) return;
		transitionInFlightRef.current = true;
		try {
			await runSetThread(threadId);
		} finally {
			transitionInFlightRef.current = false;
		}
	};

	const runSetThread = async (threadId: string) => {
		if (!client) return;
		{
			// Adapt the InFlightTool map to the AbortController map that
			// transitionThread expects for its drain step.
			const abortMap = new Map(Array.from(inFlightTools, ([id, t]) => [id, t.controller]));

			const result = await transitionThread({
				client,
				oldThreadId: state.threadId,
				newThreadId: threadId,
				configDir,
				cwd,
				hostname,
				mcpManager,
				mcpConfigs,
				logger,
				inFlightTools: abortMap,
				model: state.model,
				injectContextFiles: contextFiles,
				shell,
				sandbox,
			});

			if (!result.ok) {
				// Close the picker so the error banner in ChatView is visible.
				dispatch({ type: "SET_VIEW", view: "chat" });
				dispatch({
					type: "SET_BANNER",
					message: result.degraded
						? `Attach failed and rollback failed: ${result.error}. Session may be degraded — consider restarting.`
						: `Attach failed: ${result.error}. Staying on current thread.`,
					bannerType: "error",
				});
				return;
			}

			// Clear terminal scrollback so the prior thread's <Static> output
			// doesn't linger above the new thread. Standard ANSI clear+home+
			// scrollback-clear; no-op when stdout isn't a TTY.
			if (process.stdout.isTTY) {
				process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
			}

			// performAttach already fetched the canonical message list
			// (bounded by the same 200-msg cap used at startup).
			replaceMessages(result.attachResult.messages);
			dispatch({ type: "SET_THREAD", threadId: result.threadId });

			// Resume the thread on the model it last used. A thread with no
			// model-bearing history (fresh thread, or model rows outside the
			// fetch window) keeps the current selection.
			const inheritedModel = result.attachResult.lastUsedModelId;
			if (inheritedModel && inheritedModel !== state.model) {
				dispatch({ type: "SET_MODEL", model: inheritedModel });
				dispatch({
					type: "SET_BANNER",
					message: `Model set to ${bannerModel(inheritedModel)} (last used in this thread)`,
					bannerType: "info",
				});
			}
		}
	};

	const handleSetModel = (model: string) => {
		dispatch({ type: "SET_MODEL", model });
	};

	// `/model <name>`: resolve against the available models so a typo is an
	// error, not a silently-accepted unknown id.
	const handleModelByName = async (name: string) => {
		if (!client) return;
		try {
			const res = await client.listModels();
			const candidates: ModelCandidate[] = res.models.map((m) => ({
				id: m.logical_model ?? m.id,
				aliases: [
					m.id,
					m.logical_model ?? null,
					m.display_name ?? null,
					modelDisplayNames.get(m.id) ?? null,
				],
			}));
			const match = resolveModelName(name, candidates);
			if (!match) {
				handleSetBanner(`Unknown model: ${name}. Run /model to pick from the list.`, "error");
				return;
			}
			handleSetModel(match);
			handleSetBanner(`Model switched to ${bannerModel(match)}`, "info");
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			handleSetBanner(`Could not load models: ${errorMsg}`, "error");
		}
	};

	const handleSetBanner = (message: string | null, bannerType: "error" | "info" | null) => {
		dispatch({ type: "SET_BANNER", message, bannerType });
	};

	const handleDismissBanner = () => {
		dispatch({ type: "DISMISS_BANNER" });
	};

	const handleClear = useCallback(async () => {
		if (!client) return;
		setIsProcessing(false);

		const abortMap = new Map(Array.from(inFlightTools, ([id, t]) => [id, t.controller]));

		const result = await transitionThread({
			client,
			oldThreadId: state.threadId,
			newThreadId: null, // /clear → create fresh thread
			configDir,
			cwd,
			hostname,
			mcpManager,
			mcpConfigs,
			logger,
			inFlightTools: abortMap,
			model: state.model,
			injectContextFiles: contextFiles,
			shell,
			sandbox,
		});

		if (!result.ok) {
			dispatch({
				type: "SET_BANNER",
				message: result.degraded
					? `Clear failed and rollback failed: ${result.error}. Session may be degraded — consider restarting.`
					: `Clear failed: ${result.error}. Staying on current thread.`,
				bannerType: "error",
			});
			return;
		}

		clearMessages();
		// Clear terminal scrollback so the prior thread's <Static> output
		// doesn't linger above the fresh thread. Same rationale as
		// handleSetThread.
		if (process.stdout.isTTY) {
			process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		}
		dispatch({ type: "SET_THREAD", threadId: result.threadId });
	}, [
		client,
		state.threadId,
		state.model,
		contextFiles,
		configDir,
		cwd,
		hostname,
		mcpManager,
		mcpConfigs,
		logger,
		inFlightTools,
		clearMessages,
		shell,
		sandbox,
	]);
	const handleSendMessage = async (message: string | ContentBlock[]) => {
		if (client) {
			// Optimistically render the user's message immediately. The real
			// `message:created` (sometimes >3s later) reconciles this placeholder;
			// see #88 and useMessages.appendPendingUserMessage. Block sends
			// (image paste) flatten to a text sketch for the placeholder — the
			// real message renders the preview when it arrives.
			const placeholderText =
				typeof message === "string"
					? message
					: message
							.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
							.filter((t) => t.length > 0)
							.join(" ");
			appendPendingUserMessage(state.threadId, placeholderText);
			try {
				await client.sendMessage(state.threadId, message, { modelId: state.model || undefined });
			} catch (error) {
				// The send never reached the server — drop the placeholder so it
				// doesn't linger as a phantom turn.
				clearPendingUserMessage();
				const errorMsg = error instanceof Error ? error.message : String(error);
				handleSetBanner(`Failed to send message: ${errorMsg}`, "error");
			}
		}
	};

	// View routing
	return (
		<Box flexDirection="column">
			<ChatView
				key={state.threadId}
				client={client}
				threadId={state.threadId}
				model={modelDisplay}
				connectionState={connectionState}
				cwd={cwd}
				commitHash={commitHash}
				messages={messages}
				inFlightTools={inFlightTools}
				mcpServerCount={mcpServerCount}
				bannerMessage={state.bannerMessage}
				bannerType={state.bannerType}
				ctrlCHint={ctrlCHint}
				isProcessing={isProcessing}
				onModelChange={(name) => void handleModelByName(name)}
				onModelPicker={() => handleSetView("picker", "model")}
				onAttachThread={() => handleSetView("picker", "thread")}
				onMcpView={() => handleSetView("mcp")}
				onInspect={() => handleSetView("inspector")}
				onClear={handleClear}
				onBannerDismiss={handleDismissBanner}
				onSendMessage={handleSendMessage}
				active={state.view === "chat"}
				sandbox={sandbox}
				sandboxOverrides={sandboxOverrides}
				sandboxAvailable={sandboxAvailable}
			/>
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
			{state.view === "inspector" && (
				<InspectorView messages={messages} onClose={() => handleSetView("chat")} />
			)}
			{state.view === "picker" && state.pickerMode && (
				<PickerView
					mode={state.pickerMode}
					client={client}
					currentValue={state.pickerMode === "model" ? (state.model ?? undefined) : undefined}
					onSelect={(value) => {
						if (state.pickerMode === "thread") {
							handleSetThread(value);
						} else if (state.pickerMode === "model") {
							handleSetModel(value);
							handleSetView("chat");
							handleSetBanner(`Model switched to ${bannerModel(value)}`, "info");
						}
					}}
					onCancel={() => handleSetView("chat")}
				/>
			)}
		</Box>
	);
}
