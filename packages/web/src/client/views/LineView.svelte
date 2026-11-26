<script lang="ts">
	import type { ThreadDetail, TurnProvenanceInfo } from "@bound/client";
	import type { YardExecutionEvent } from "@bound/shared";
	import { ChevronLeft, Paperclip, Pencil } from "lucide-svelte";
	import { onDestroy, onMount, tick } from "svelte";
	import Btn from "../components/Btn.svelte";
	import ContextDebugPanel from "../components/ContextDebugPanel.svelte";
	import LineBadge from "../components/LineBadge.svelte";
	import McpAppPanel from "../components/McpAppPanel.svelte";
	import MessageList from "../components/MessageList.svelte";
	import ModelSelector from "../components/ModelSelector.svelte";
	import StatusChip from "../components/StatusChip.svelte";
	import ThreadModelChip from "../components/ThreadModelChip.svelte";
	import { reduceActiveAuxRuns } from "../lib/aux-invoke-cards";
	import { client, connectWebSocket, subscribeToThread, wsEvents } from "../lib/bound";
	import { fmtHhmm, formatRelativeTime } from "../lib/format-time";
	import type { McpAppHost } from "../lib/mcp-app-host";
	import {
		type McpAppInstanceMap,
		instancesForThread,
		mcpAppHost,
		mcpAppInstances,
		reconstructInstancesFromMessages,
	} from "../lib/mcp-app-store";
	import { contentPreviewText } from "../lib/message-grouping";
	import { getLineColor, getLineName } from "../lib/metro-lines";
	import { type ModelLabels, buildModelLabels, parseRouteId } from "../lib/model-labels";
	import { modelStore } from "../lib/modelStore";
	import { navigateTo } from "../lib/router";
	import {
		attachedSessionHosts,
		attachedSessionLabel,
		attachedSessionTitle,
	} from "../lib/session-badge";
	import { MAX_THREAD_TITLE_LENGTH, resolveTitleEdit } from "../lib/thread-title";
	import {
		EMPTY_YARD_STATE,
		type YardExecutionState,
		reconcileYardExecutions,
		reduceYardExecution,
	} from "../lib/yard-execution";
	import { shouldClearWaiting } from "../utils/waiting";

	const { threadId, from } = $props<{ threadId: string; from?: string }>();

	interface LocalMessage {
		id: string;
		role: string;
		content: string;
		tool_name?: string | null;
		model_id?: string | null;
		created_at?: string;
	}

	let messages = $state<LocalMessage[]>([]);
	let inputText = $state("");
	let sending = $state(false);
	let waiting = $state(false);
	let waitingSinceMessageCount = $state(0);
	let agentActive = $state(false);
	let agentState = $state<string | null>(null);
	let uploadStatus = $state<string | null>(null);
	let pendingFiles = $state<File[]>([]);
	let activeAuxRuns = $state<Array<{ threadId: string; agentName: string }>>([]);
	let thread = $state<ThreadDetail | null>(null);
	let panelMode = $state<"context" | "debugger">("context");

	// Streaming state: accumulates partial text and reasoning from the agent while
	// it's generating. Cleared when the full persisted message arrives via message:created.
	let streamingText = $state("");
	let streamingReasoning = $state("");

	// A selected-turn range emitted by the debugger's turn scrubber. When set, the
	// conversation dims other turns and scrolls the selected one into view.
	let turnRange = $state<{ from: string; to: string | null } | null>(null);
	// Context-panel turn click → scroll the conversation to that message. The nonce
	// bumps per click so clicking the same turn twice still re-fires the scroll.
	let scrollRequest = $state<{ messageId: string; nonce: number } | null>(null);
	let scrollNonce = 0;
	function scrollToTurn(messageId: string | undefined): void {
		if (!messageId) return;
		scrollNonce += 1;
		scrollRequest = { messageId, nonce: scrollNonce };
	}

	let yardState = $state<YardExecutionState>(EMPTY_YARD_STATE);
	const yardTrees = $derived([...yardState.live.values(), ...yardState.completed]);
	const onYardExecution = (event: YardExecutionEvent): void => {
		if (event.thread_id === threadId) yardState = reduceYardExecution(yardState, event);
	};

	// Per-turn routing provenance (2026-11-21-model-routing.md §9.1), fetched on
	// mount and refreshed each poll. Drives the per-message footer and the thread
	// header chip's off-preferred / pinned styling, plus the two §9.2 notices.
	let turnProvenance = $state<TurnProvenanceInfo[]>([]);
	// Logical model id → user-facing display name (spec §2.1), from the routing
	// catalog. The provenance footer and header chip show this, never the internal
	// grouping key. Falls back to the id itself when the catalog has no entry.
	let modelDisplayNames = $state<Map<string, string>>(new Map());

	let routeLabels = $state<ModelLabels>(buildModelLabels([]));
	let hostBySite = $state<Map<string, string>>(new Map());
	let liveModel = $state<string | null>(null);
	let pickedModel = $state<string | null>(null);
	let storeModel = $state(modelStore.getModel());
	const unsubscribeModelStore = modelStore.subscribe((m) => {
		storeModel = m;
	});
	onDestroy(unsubscribeModelStore);

	function describeRoute(routeId: string | null): { label: string; host: string | null } {
		const parsed = routeId ? parseRouteId(routeId) : null;
		return {
			label: routeLabels.routeLabel(routeId),
			host: parsed ? (hostBySite.get(parsed.siteId) ?? null) : null,
		};
	}

	function modelDisplay(modelId: string | null): string {
		if (!modelId) return "\u2014";
		return modelDisplayNames.get(modelId) ?? modelId;
	}

	async function loadProvenance(): Promise<void> {
		try {
			const data = await client.getThreadProvenance(threadId);
			turnProvenance = data.turns;
		} catch (error) {
			console.error("Failed to load thread provenance:", error);
		}
	}

	async function loadModelDisplayNames(): Promise<void> {
		try {
			const data = await client.getRoutingModels();
			// Key by the logical model AND every route's backend id: a turn's
			// model_id is the serving backend id (e.g. `zai-glm-5.3-flash`), which
			// never equals the logical model key. RouteId is
			// `${siteId}:${provider}:${backendId}`, and a backend id may itself
			// contain colons (Bedrock `...-v1:0`).
			const names = new Map<string, string>();
			for (const m of data.models) {
				if (!m.display_name) continue;
				names.set(m.logical_model, m.display_name);
				for (const r of m.routes) {
					const backendId = parseRouteId(r.route_id)?.backendId;
					if (backendId && !names.has(backendId)) names.set(backendId, m.display_name);
				}
			}
			modelDisplayNames = names;
			routeLabels = buildModelLabels(data.models);
			const hosts = new Map<string, string>();
			for (const m of data.models) for (const r of m.routes) hosts.set(r.site_id, r.host_name);
			hostBySite = hosts;
		} catch {
			// Best-effort: an older server leaves the footer/chip showing the id.
		}
	}

	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let namesInterval: ReturnType<typeof setInterval> | null = null;

	// MCP App panels for this thread, rebuilt from persisted tool_result bindings.
	let appInstanceMap = $state<McpAppInstanceMap>({});
	const unsubscribeApps = mcpAppInstances.subscribe((map) => {
		appInstanceMap = map;
	});
	const threadAppInstances = $derived(instancesForThread(appInstanceMap, threadId));

	// Reload + live render trigger: the in-memory instance store is empty on a
	// fresh page load, but the agent's UI-bearing tool_call rows survive in the
	// message history AND new ones stream in live over the WS. Whenever the MCP
	// host is connected (so we can resolve tool names — including the agent's
	// omnibus `<server>`-command shape, where the real tool is in
	// `input.subcommand` — back to UI-bearing registrations) and this thread has
	// messages, (re)scan them and register any UI-bearing instance not already
	// live. Host-ready and messages-loaded can land in either order, and live
	// messages arrive incrementally, so the scan runs from all of: the host
	// subscription, onMount, the poll, and each live message:created. It's
	// idempotent — the callId guard never clobbers or re-mounts an instance already
	// in the store — so re-running it per message is cheap.
	let appHost = $state<McpAppHost | null>(null);
	const unsubscribeHost = mcpAppHost.subscribe((h) => {
		appHost = h;
		scanForAppPanels();
	});

	function scanForAppPanels(): void {
		if (!appHost || messages.length === 0) return;
		const live = appInstanceMap;
		for (const inst of reconstructInstancesFromMessages(messages, appHost, threadId)) {
			if (!(inst.callId in live)) mcpAppInstances.register(inst);
		}
	}

	// Subscribe to WebSocket events and append new messages
	const unsubscribeWs = wsEvents.subscribe((events) => {
		if (events.length === 0) return;
		const last = events[events.length - 1];
		if (last?.type === "aux:started" && typeof last.data === "object" && last.data !== null) {
			const aux = last.data as {
				thread_id?: string;
				parent_thread_id?: string;
				agent_name?: string;
			};
			if (aux.parent_thread_id === threadId && aux.thread_id && aux.agent_name) {
				activeAuxRuns = reduceActiveAuxRuns(activeAuxRuns, {
					type: "aux:started",
					thread_id: aux.thread_id,
					agent_name: aux.agent_name,
				});
			}
			return;
		}
		if (last?.type === "aux:completed" && typeof last.data === "object" && last.data !== null) {
			const aux = last.data as { thread_id?: string; parent_thread_id?: string };
			if (aux.parent_thread_id === threadId && aux.thread_id)
				activeAuxRuns = reduceActiveAuxRuns(activeAuxRuns, {
					type: "aux:completed",
					thread_id: aux.thread_id,
				});
			return;
		}
		if (
			last &&
			last.type === "message:created" &&
			typeof last.data === "object" &&
			last.data !== null
		) {
			const msg = last.data as { thread_id?: string; id?: string; role?: string };
			if (msg.thread_id === threadId) {
				const exists = messages.some((m) => m.id === msg.id);
				if (!exists) {
					messages = [...messages, last.data as LocalMessage];
					yardState = reconcileYardExecutions(yardState, messages);
					// A UI-bearing tool_call/result just streamed in — (re)scan so its
					// app panel mounts live, not only on the next reload.
					scanForAppPanels();
				}
				if (shouldClearWaiting(msg.role ?? "")) {
					waiting = false;
				}
				// Clear streaming text when any agent-side message lands (assistant,
				// tool_call, or tool_result). The first persisted message after
				// streaming means the turn progressed past the streaming phase.
				if (msg.role !== "user") {
					streamingText = "";
					streamingReasoning = "";
				}
			}
		}
	});

	let pollInFlight = false;
	let destroyed = false;
	let loadError = $state<string | null>(null);
	let lastProvenanceKey = "";

	/**
	 * Merge a polled snapshot with the live list by id: the poll is authoritative
	 * for the rows it returns, and any WS-appended row it does not yet include is
	 * kept so a slow poll never erases a newer live message.
	 */
	function mergeMessages(current: LocalMessage[], latest: LocalMessage[]): LocalMessage[] {
		const ids = new Set(latest.map((m) => m.id));
		const extras = current.filter((m) => !ids.has(m.id));
		return extras.length === 0 ? latest : [...latest, ...extras];
	}

	async function pollMessages(): Promise<void> {
		if (pollInFlight) return;
		pollInFlight = true;
		try {
			const latest = (await client.listMessages(threadId)) as unknown as LocalMessage[];
			if (destroyed) return;
			const known = new Set(messages.map((m) => m.id));
			const newMessages = latest.filter((m) => !known.has(m.id));
			// If poll discovers new non-user messages, clear streaming text —
			// the persisted content supersedes the streaming preview.
			if ((streamingText || streamingReasoning) && newMessages.some((m) => m.role !== "user")) {
				streamingText = "";
				streamingReasoning = "";
			}
			messages = mergeMessages(messages, latest);
			yardState = reconcileYardExecutions(yardState, messages);
			scanForAppPanels();
			if (
				waiting &&
				latest.length > waitingSinceMessageCount &&
				latest.slice(waitingSinceMessageCount).some((m) => shouldClearWaiting(m.role))
			) {
				waiting = false;
			}
			maybeLoadProvenance();
		} catch (error) {
			console.error("Failed to poll messages:", error);
		} finally {
			pollInFlight = false;
		}
	}

	/** Re-fetch provenance only when the message count or processing state moved. */
	function maybeLoadProvenance(): void {
		const key = `${messages.length}:${agentActive}:${agentState ?? ""}`;
		if (key === lastProvenanceKey) return;
		lastProvenanceKey = key;
		void loadProvenance();
	}

	// Re-poll the server-computed thread status on the same cadence as messages.
	// The status chip otherwise only updates from live `thread:status` WS events,
	// which the scheduler does not emit cross-host — so a thread woken by an event
	// on another host would stay "idle" in this view. The `/status` endpoint
	// derives `active` from the synced `tasks.status='running'` signal, which is
	// correct regardless of which host runs the task (#42).
	async function pollStatus(): Promise<void> {
		try {
			const data = await client.getThreadStatus(threadId);
			handleThreadStatus(data);
		} catch {
			// Transient — the next tick retries. Don't spam the console.
		}
	}

	function handleThreadStatus(data: unknown): void {
		const status = data as {
			thread_id?: string;
			active?: boolean;
			state?: string | null;
			model?: string | null;
		};
		// `thread:status` is a global event — filter to events for this thread only,
		// otherwise activity in any sibling thread flips this view's indicator on.
		if (status.thread_id && status.thread_id !== threadId) return;
		agentActive = status.active ?? false;
		agentState = status.state ?? null;
		liveModel = status.active ? (status.model ?? null) : null;
		if (waiting && !status.active) waiting = false;
		// Clear streaming text when the agent goes idle — defense-in-depth for
		// cases where message:created arrives late or is dropped entirely.
		if (!status.active && (streamingText || streamingReasoning)) {
			streamingText = "";
			streamingReasoning = "";
		}
	}

	function handleStreamChunk(data: unknown): void {
		const evt = data as {
			thread_id?: string;
			chunk?: { type?: string; content?: string; redacted_data?: string };
		};
		if (evt.thread_id !== threadId) return;
		if (evt.chunk?.type === "text" && evt.chunk.content) {
			streamingText += evt.chunk.content;
		}
		if (evt.chunk?.type === "thinking" && evt.chunk.content) {
			streamingReasoning += evt.chunk.content;
		}
	}

	async function loadInitial(): Promise<void> {
		try {
			const loadedThread = await client.getThread(threadId);
			const loadedMessages = (await client.listMessages(threadId)) as unknown as LocalMessage[];
			if (destroyed) return;
			thread = loadedThread;
			messages = mergeMessages(messages, loadedMessages);
			loadError = null;
			yardState = reconcileYardExecutions(yardState, messages);
			scanForAppPanels();
			maybeLoadProvenance();
		} catch (error) {
			if (destroyed) return;
			loadError = error instanceof Error ? error.message : "Failed to load thread";
		}
	}

	onMount(async () => {
		client.on("yard:execution", onYardExecution);
		client.on("thread:status", handleThreadStatus);
		client.on("stream:chunk", handleStreamChunk);
		connectWebSocket();
		subscribeToThread(threadId);
		void loadModelDisplayNames();

		await loadInitial();
		if (destroyed) return;

		pollInterval = setInterval(() => {
			void pollMessages();
			void pollStatus();
		}, 5000);
		// Display names change only when the catalog does; refresh slowly.
		namesInterval = setInterval(() => void loadModelDisplayNames(), 60_000);

		try {
			const data = await client.getThreadStatus(threadId);
			if (!destroyed) handleThreadStatus(data);
		} catch (error) {
			console.error("Failed to load thread status:", error);
		}
	});

	onDestroy(() => {
		destroyed = true;
		client.off("yard:execution", onYardExecution);
		unsubscribeWs();
		unsubscribeApps();
		unsubscribeHost();
		// Drop only this thread's subscription. The WebSocket itself is shared
		// app-wide (SystemMap status chips, FilesView updates, MCP App tool
		// dispatch) — closing it here would silently kill those for the rest of
		// the tab's life. The unsubscribe also soft-deletes this connection's
		// client_sessions row server-side.
		client.unsubscribe(threadId);
		if (pollInterval !== null) clearInterval(pollInterval);
		if (namesInterval !== null) clearInterval(namesInterval);
		client.off("thread:status", handleThreadStatus);
		client.off("stream:chunk", handleStreamChunk);
	});

	async function handleSendMessage(): Promise<void> {
		if (!inputText.trim() && pendingFiles.length === 0) return;
		if (sending) return;
		sending = true;
		try {
			// #158: the attachment is held client-side until now and uploaded as
			// part of the send. If the upload fails, abort the whole send — keep the
			// text and the held file so the user can retry — rather than dispatching
			// a message that references a file that never landed.
			const fileIds: string[] = [];
			if (pendingFiles.length > 0) {
				uploadStatus = `Uploading ${pendingFiles.length} attachment${pendingFiles.length === 1 ? "" : "s"}…`;
				try {
					for (const file of pendingFiles) {
						const uploaded = await client.uploadFile(file, file.name);
						if (uploaded.id) fileIds.push(uploaded.id);
					}
				} catch (error) {
					console.error("Failed to upload attachment:", error);
					uploadStatus = "Upload failed — message not sent";
					return;
				}
			}
			client.sendMessage(threadId, inputText.trim(), {
				modelId: modelStore.getModel() || undefined,
				fileIds,
			});
			inputText = "";
			pendingFiles = [];
			uploadStatus = null;
			waitingSinceMessageCount = messages.length;
			waiting = true;
		} catch (error) {
			console.error("Failed to send message:", error);
		} finally {
			sending = false;
		}
	}

	async function handleCancel(): Promise<void> {
		try {
			await client.cancelThread(threadId);
		} catch (error) {
			console.error("Failed to cancel agent:", error);
		}
	}

	let fileInputEl: HTMLInputElement | null = null;

	function handleFileChange(e: Event): void {
		const input = e.target as HTMLInputElement;
		if (!input.files || input.files.length === 0) return;
		// #158: hold files, don't upload yet — upload happens atomically on send.
		pendingFiles = [...pendingFiles, ...Array.from(input.files)];
		uploadStatus = `${pendingFiles.length} attachment${pendingFiles.length === 1 ? "" : "s"} staged`;
		input.value = "";
	}

	function handleBackClick(): void {
		navigateTo(from ?? "/");
	}

	function handlePaste(e: ClipboardEvent): void {
		const imageFiles = Array.from(e.clipboardData?.files ?? []).filter((file) =>
			file.type.startsWith("image/"),
		);
		if (imageFiles.length === 0) return;
		// Let text paste retain the browser default; image clipboard items become
		// ordinary staged attachments and travel through the same upload path.
		e.preventDefault();
		pendingFiles = [...pendingFiles, ...imageFiles];
		uploadStatus = `${pendingFiles.length} attachment${pendingFiles.length === 1 ? "" : "s"} staged`;
	}

	function handleKeydown(e: KeyboardEvent): void {
		// isComposing: the Enter that commits an IME composition (CJK input) must
		// not dispatch the half-composed message.
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			handleSendMessage();
		}
	}

	function viewTitle(): string {
		if (thread?.title && thread.title.trim().length > 0) return thread.title.trim();
		if (messages.length === 0) return "New Conversation";
		return "Conversation";
	}

	// Inline header rename, same contract as ThreadList's: Enter or blur saves,
	// Escape cancels, and a blank or unchanged title closes without a request.
	let editingTitle = $state(false);
	let titleDraft = $state("");
	let titleInput = $state<HTMLInputElement | undefined>();
	let committingTitle = $state(false);
	let renameError = $state<string | null>(null);

	async function startRename(): Promise<void> {
		if (!thread) return;
		// Seed from the stored title, never the placeholder viewTitle() shows for
		// an untitled thread: a placeholder draft would compare as a change and a
		// stray blur would save it, which also blocks the generated title for good.
		titleDraft = thread.title?.trim() ?? "";
		renameError = null;
		editingTitle = true;
		await tick();
		titleInput?.focus();
		titleInput?.select();
	}

	function cancelRename(): void {
		editingTitle = false;
		titleDraft = "";
	}

	async function commitRename(): Promise<void> {
		if (!editingTitle || committingTitle || !thread) return;
		const title = resolveTitleEdit(titleDraft, thread.title);
		if (title === null) {
			cancelRename();
			return;
		}
		committingTitle = true;
		try {
			const updated = await client.renameThread(threadId, title);
			if (thread) thread = { ...thread, title: updated.title ?? title };
		} catch (error) {
			renameError = error instanceof Error ? error.message : "Rename failed";
		} finally {
			committingTitle = false;
			cancelRename();
		}
	}

	function onTitleKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			cancelRename();
		} else if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			void commitRename();
		}
	}

	const lineColor = $derived(thread ? getLineColor(thread.color) : "#999");
	const lineName = $derived(thread ? getLineName(thread.color) : "");

	// Right-side Context pane info
	const allToolCalls = $derived(messages.filter((m) => m.role === "tool_call").length);
	const firstMessageAt = $derived(messages[0]?.created_at ?? null);

	// The latest message's serving model (a backend id); also the selector's
	// prefill when the thread has no model_hint.
	const latestMessageModel = $derived.by((): string | null => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const mid = messages[i].model_id;
			if (mid) return mid;
		}
		return null;
	});

	// Thread's active model. An explicit pick in ModelSelector, the thread's
	// model_hint, or a running turn's live model wins immediately; otherwise the
	// latest message's model, then the picker's store value.
	const activeModel = $derived.by((): string => {
		if (pickedModel) return pickedModel;
		if (thread?.model_hint) return thread.model_hint;
		if (agentActive && liveModel) return liveModel;
		return latestMessageModel ?? (storeModel || "\u2014");
	});
	// Thread header chip + off-preferred / pin styling (§9.1). The latest turn's
	// route_id tells us the serving host/provider; when it differs from the
	// model's preferred route the chip shows a `· via host / provider` suffix.
	// `route_id` is `${siteId}:${provider}:${backendId}`; the chip renders
	// `provider` + host. We only surface the suffix when a substitution or a
	// non-default route is in play — approximated here by a turn carrying a
	// `substituted_from` (ran off its preferred model/route).
	const latestTurn = $derived.by((): TurnProvenanceInfo | null => {
		if (turnProvenance.length === 0) return null;
		return turnProvenance.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
	});

	function routeParts(routeId: string | null): { host: string | null; provider: string | null } {
		const parsed = routeId ? parseRouteId(routeId) : null;
		if (!parsed) return { host: null, provider: null };
		return { host: hostBySite.get(parsed.siteId) ?? null, provider: parsed.provider };
	}

	// Substitution = the model itself was swapped (refusal); failover = same
	// model served by a later route after a route error. They read differently.
	const chipKind = $derived.by((): "substitution" | "failover" | null => {
		const t = latestTurn;
		if (!t) return null;
		if (t.substituted_from && t.substituted_from !== t.model_id) return "substitution";
		if (t.substituted_from || t.attempts?.some((a) => a.outcome === "route-error"))
			return "failover";
		return null;
	});

	const chipVia = $derived.by((): { host: string | null; provider: string | null } => {
		const t = latestTurn;
		if (!t || !chipKind) return { host: null, provider: null };
		return routeParts(t.route_id);
	});

	// Model-substitution notice (§9.2): surfaced when the latest turn ran a
	// different model than requested. `substituted_from` is the original.
	const modelSubstitution = $derived.by(
		(): {
			original: string;
			substitute: string | null;
			category: string | null;
			explanation: string | null;
		} | null => {
			const t = latestTurn;
			if (!t || !t.substituted_from) return null;
			const refusal = t.attempts?.find((a) => a.outcome === "refusal");
			return {
				original: t.substituted_from,
				substitute: t.model_id,
				category: refusal?.refusal_category ?? null,
				explanation: null,
			};
		},
	);

	// Route-failover notice (§9.2): a single thread-level notice once one route
	// has failed repeatedly across the recent turn window. Count route-error
	// attempts per route over the last turns; surface the worst offender when it
	// crosses the threshold and a healthier route is now serving.
	const FAILOVER_WINDOW = 5;
	const FAILOVER_THRESHOLD = 3;
	const routeFailover = $derived.by(
		(): {
			failedRoute: string;
			failedCount: number;
			windowSize: number;
			servingRoute: string;
		} | null => {
			const recent = turnProvenance.slice(-FAILOVER_WINDOW);
			if (recent.length === 0) return null;
			const failures = new Map<string, number>();
			for (const t of recent) {
				for (const a of t.attempts ?? []) {
					if (a.outcome === "route-error" && a.route_id) {
						failures.set(a.route_id, (failures.get(a.route_id) ?? 0) + 1);
					}
				}
			}
			let worst: { route: string; count: number } | null = null;
			for (const [route, count] of failures) {
				if (!worst || count > worst.count) worst = { route, count };
			}
			if (!worst || worst.count < FAILOVER_THRESHOLD) return null;
			const serving = latestTurn?.route_id;
			if (!serving || serving === worst.route) return null;
			const label = (routeId: string): string => {
				const p = routeParts(routeId);
				return p.host && p.provider ? `${p.host} / ${p.provider}` : routeId;
			};
			return {
				failedRoute: label(worst.route),
				failedCount: worst.count,
				windowSize: recent.length,
				servingRoute: label(serving),
			};
		},
	);

	// User-message turn stops for the mini-timeline in the Context pane. Each
	// user message is a "stop" on the line; the last is the current turn.
	const userTurns = $derived(messages.filter((m) => m.role === "user"));

	function turnPreview(content: string): string {
		const compact = contentPreviewText(content).replace(/\s+/g, " ").trim();
		if (compact.length <= 56) return compact;
		return `${compact.slice(0, 55)}…`;
	}
</script>

<div class="line-view" style="--line-color: {lineColor}">
	{#if loadError}
		<div class="load-error" role="alert">
			<span>Failed to load thread: {loadError}</span>
			<button type="button" onclick={() => void loadInitial()}>Retry</button>
		</div>
	{/if}
	<!-- Header -->
	<div class="line-header">
		<button class="back-btn" onclick={handleBackClick}>
			<ChevronLeft size={14} />
			Map
		</button>

		<div class="title-block">
			{#if thread}
				<LineBadge lineIndex={thread.color} size="large" />
			{/if}
			<div class="title-text">
				{#if thread}
					<div class="kicker">{lineName} Line</div>
				{/if}
				{#if editingTitle}
					<input
						class="title-input"
						bind:this={titleInput}
						bind:value={titleDraft}
						maxlength={MAX_THREAD_TITLE_LENGTH}
						disabled={committingTitle}
						placeholder={viewTitle()}
						aria-label="Thread title"
						onkeydown={onTitleKeydown}
						onblur={() => void commitRename()}
					/>
				{:else}
					<div class="title-row">
						<h1 class="title">{viewTitle()}</h1>
						{#if thread}
							<button
								type="button"
								class="rename-button"
								title="Rename thread"
								aria-label={`Rename ${viewTitle()}`}
								onclick={() => void startRename()}
							>
								<Pencil size={14} />
							</button>
						{/if}
					</div>
				{/if}
				{#if renameError}
					<p class="rename-error" role="alert">Rename failed: {renameError}</p>
				{/if}
			</div>
			{#if thread}
				<StatusChip status={agentActive ? "active" : "idle"} />
				<ThreadModelChip
					model={modelDisplay(activeModel)}
					viaHost={chipVia.host}
					viaProvider={chipVia.provider}
					kind={chipKind}
				/>
				{@const sessionHosts = attachedSessionHosts(thread)}
				{#if sessionHosts.length > 0}
					<span class="session-badge" title={attachedSessionTitle(sessionHosts)}>
						<span class="session-dot"></span>
						<span class="session-host">{attachedSessionLabel(sessionHosts)}</span>
					</span>
				{/if}
			{/if}
			{#if agentActive}
				<span class="agent-state mono">
					{agentState === "tool_call" ? "Using tool…" : "Thinking…"}
				</span>
				<Btn variant="danger" size="sm" onclick={handleCancel}>
					{#snippet children()}Cancel{/snippet}
				</Btn>
			{/if}
		</div>
	</div>

	<!-- Body: conversation + right panel -->
	<div class="body">
		<div class="conversation">
			{#each activeAuxRuns as aux (aux.threadId)}
				<div class="aux-running mono">aux: {aux.agentName} running · thread {aux.threadId}</div>
			{/each}
			<MessageList
				{messages}
				{waiting}
				{streamingText}
				{streamingReasoning}
				turnRange={panelMode === "debugger" ? turnRange : null}
				scrollRequest={panelMode === "context" ? scrollRequest : null}
				threadColor={thread?.color ?? 0}
				userDisplayName={thread?.userDisplayName ?? null}
				{lineColor}
				isAgentActive={agentActive}
				appInstances={threadAppInstances}
				{yardTrees}
				{turnProvenance}
				{describeRoute}
				{modelDisplay}
				{routeFailover}
				{modelSubstitution}
			/>

			<!-- Input bar -->
			<div class="input-wrap">
				<div class="input-row">
					<textarea
						bind:value={inputText}
						placeholder="Address the agent…"
						rows={2}
						disabled={sending}
						onkeydown={handleKeydown}
						onpaste={handlePaste}></textarea>
					<button
						class="dispatch"
						class:active={inputText.trim().length > 0}
						onclick={handleSendMessage}
						disabled={sending || (!inputText.trim() && pendingFiles.length === 0)}
					>
						{sending ? "Sending" : "Dispatch"}
					</button>
				</div>
				<div class="input-meta">
					<ModelSelector
						modelHint={thread?.model_hint}
						fallbackModel={latestMessageModel}
						onselect={(id) => {
							pickedModel = id;
						}}
					/>
					<label class="attach">
						<Paperclip size={11} />
						Attach
						<input
							type="file"
							class="file-input"
							multiple
							onchange={handleFileChange}
							bind:this={fileInputEl}
						/>
					</label>
					{#if uploadStatus}
						<span class="upload-status mono">{uploadStatus}</span>
					{/if}
					<div class="spacer"></div>
					<span class="hint">⏎ send · ⇧⏎ newline</span>
				</div>
			</div>
		</div>

		<aside class="right-panel">
			<div class="panel-toggle">
				<button
					class="mode-btn"
					class:active={panelMode === "context"}
					onclick={() => (panelMode = "context")}
				>
					Context
				</button>
				<button
					class="mode-btn"
					class:active={panelMode === "debugger"}
					onclick={() => (panelMode = "debugger")}
				>
					Debugger
				</button>
			</div>

			<div class="panel-body">
				{#if panelMode === "context"}
					<div class="context-pane">
						{#if thread}
							<div class="context-header">
								<LineBadge lineIndex={thread.color} size="compact" />
								<span class="line-title">{lineName} Line</span>
							</div>
							<div class="fields">
								<div class="field">
									<span class="kicker">Reference</span>
									<span class="mono">{thread.id.slice(0, 10)}</span>
								</div>
								<div class="field">
									<span class="kicker">Model</span>
									<span class="mono">{modelDisplay(activeModel)}</span>
								</div>
								<div class="field">
									<span class="kicker">Opened</span>
									<span class="mono">
										{firstMessageAt ? formatRelativeTime(firstMessageAt) : "—"}
									</span>
								</div>
								<div class="field">
									<span class="kicker">Messages</span>
									<span class="mono tnum">{messages.length}</span>
								</div>
								<div class="field">
									<span class="kicker">Tool calls</span>
									<span class="mono tnum">{allToolCalls}</span>
								</div>
								<div class="field">
									<span class="kicker">Status</span>
									<span class="mono" style="color: {agentActive ? 'var(--ok)' : 'var(--ink-3)'}">
										{agentActive ? "Live" : "Idle"}
									</span>
								</div>
							</div>

							{#if userTurns.length > 0}
								<div class="turns-section">
									<div class="turns-kicker">Turns · {userTurns.length}</div>
									<div class="turns-list">
										{#each userTurns as turn, i}
											{@const isLast = i === userTurns.length - 1}
											<button
												type="button"
												class="turn-stop"
												class:turn-stop-current={isLast}
												onclick={() => scrollToTurn(turn.id)}
												title="Jump to this message in the conversation"
											>
												<div class="turn-rail">
													{#if !isLast}
														<div class="turn-rail-line" style="background: {lineColor}"></div>
													{/if}
													<div
														class="turn-dot"
														class:turn-dot-current={isLast}
														style={isLast
															? `border-color: ${lineColor}; background: var(--paper)`
															: `background: ${lineColor}; border-color: ${lineColor}`}
													></div>
												</div>
												<div class="turn-body">
													<div class="turn-preview" class:turn-preview-current={isLast}>
														{turnPreview(turn.content)}
													</div>
													<div class="turn-time mono">{fmtHhmm(turn.created_at)}</div>
												</div>
											</button>
										{/each}
									</div>
								</div>
							{/if}
						{:else}
							<div class="empty">Loading thread…</div>
						{/if}
					</div>
				{:else}
					<ContextDebugPanel
						{threadId}
						{wsEvents}
						{modelDisplay}
						onTurnChange={(range) => (turnRange = range)}
					/>
				{/if}
			</div>
		</aside>
	</div>
</div>

<style>
	.line-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.line-header {
		display: flex;
		align-items: stretch;
		border-bottom: 1px solid var(--ink);
		background: var(--paper);
	}

	.back-btn {
		padding: 0 18px;
		background: var(--paper-3);
		border: none;
		border-right: 1px solid var(--rule-soft);
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12.5px;
		font-weight: 500;
	}

	.back-btn:hover {
		background: var(--paper-2);
	}

	.title-block {
		flex: 1;
		padding: 16px 22px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}

	.title-text {
		flex: 1;
		min-width: 0;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.title {
		margin: 2px 0 0;
		font-family: var(--font-header);
		font-size: 26px;
		font-weight: 700;
		letter-spacing: -0.018em;
		/* 1.08 sheared descenders (g/y/p/j) at the bottom: overflow:hidden (needed
		   for the ellipsis) clips a line box tighter than the glyph box. #162 */
		line-height: 1.25;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ink);
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.rename-button {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		border: 0;
		background: transparent;
		color: var(--ink-3);
		cursor: pointer;
	}

	.rename-button:hover,
	.rename-button:focus-visible {
		color: var(--accent);
	}

	.title-input {
		width: 100%;
		box-sizing: border-box;
		margin: 2px 0 0;
		padding: 2px 6px;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--paper);
		color: var(--ink);
		font-family: var(--font-header);
		font-size: 26px;
		font-weight: 700;
		letter-spacing: -0.018em;
		line-height: 1.25;
	}

	.rename-error {
		margin: 4px 0 0;
		font-size: var(--fs-small, 12px);
		color: var(--err);
	}

	.agent-state {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--ok);
	}

	.session-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 160px;
		padding: 3px 7px;
		border: 1px solid color-mix(in srgb, var(--accent-blue) 38%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
		color: var(--accent-blue);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		white-space: nowrap;
	}

	.session-host {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.session-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
		flex-shrink: 0;
	}

	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr 380px;
		border-top: 1px solid var(--rule-soft);
	}

	.conversation {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--paper);
		min-width: 0;
	}

	.input-wrap {
		border-top: 1px solid var(--rule-soft);
		background: var(--paper-2);
		padding: 14px 36px 18px;
		flex-shrink: 0;
	}

	.input-row {
		display: flex;
		gap: 0;
		align-items: stretch;
		border: 1px solid var(--ink);
		background: var(--paper);
	}

	textarea {
		flex: 1;
		padding: 12px 14px;
		border: none;
		outline: none;
		background: transparent;
		resize: none;
		font-family: var(--font-display);
		font-size: 14px;
		line-height: 1.5;
		color: var(--ink);
		min-height: 44px;
	}

	textarea::placeholder {
		color: var(--ink-4);
	}

	textarea:disabled {
		opacity: 0.5;
	}

	.dispatch {
		background: var(--paper-3);
		color: var(--ink-4);
		border: none;
		padding: 0 24px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		cursor: not-allowed;
	}

	.dispatch.active {
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}

	.dispatch.active:hover:not(:disabled) {
		background: var(--accent-2);
	}

	.input-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}

	.attach {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px dashed var(--rule-soft);
		background: transparent;
		cursor: pointer;
		font-size: 11.5px;
		color: var(--ink-3);
		font-family: var(--font-display);
		font-weight: 500;
		user-select: none;
	}

	.attach:hover {
		color: var(--ink-2);
		border-color: var(--ink-4);
	}

	.file-input {
		display: none;
	}

	.upload-status {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ok);
	}

	.spacer {
		flex: 1;
	}

	.hint {
		font-size: 11px;
		color: var(--ink-4);
	}

	.right-panel {
		background: var(--paper-2);
		border-left: 1px solid var(--rule-soft);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.panel-toggle {
		display: flex;
		padding: 12px 14px;
		border-bottom: 1px solid var(--rule-soft);
		background: var(--paper);
		gap: 0;
		flex-shrink: 0;
	}

	.mode-btn {
		flex: 1;
		padding: 7px 10px;
		background: transparent;
		color: var(--ink-2);
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
	}

	.mode-btn:first-child {
		border-right: none;
	}

	.mode-btn.active {
		background: var(--ink);
		color: var(--paper);
		border-color: var(--ink);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 20px 22px;
	}

	.context-pane .context-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}

	.line-title {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 14px;
		color: var(--ink);
	}

	.fields {
		display: grid;
		row-gap: 8px;
		border-top: 1px solid var(--rule-faint);
		padding-top: 12px;
	}

	.field {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.field .kicker {
		color: var(--ink-4);
	}

	.field .mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 12px;
		color: var(--ink);
	}

	.empty {
		color: var(--ink-4);
		font-style: italic;
		font-size: 13px;
		text-align: center;
		padding: 32px 0;
	}

	.turns-section {
		margin-top: 20px;
	}

	.turns-kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 10px;
	}

	.turns-list {
		display: flex;
		flex-direction: column;
	}

	.turn-stop {
		display: grid;
		grid-template-columns: 24px 1fr;
		align-items: flex-start;
		min-height: 32px;
		width: 100%;
		box-sizing: border-box;
		border: none;
		background: none;
		padding: 0;
		margin: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		transition: background 0.12s ease;
	}

	.turn-stop:hover {
		background: var(--rule-soft);
	}

	.turn-stop:focus-visible {
		outline: 2px solid var(--ink-3);
		outline-offset: -1px;
	}

	.turn-rail {
		position: relative;
		height: 100%;
		display: flex;
		justify-content: center;
	}

	.turn-rail-line {
		position: absolute;
		top: 14px;
		bottom: -14px;
		width: 3px;
	}

	.turn-dot {
		margin-top: 6px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 2px solid;
		z-index: 1;
	}

	.turn-dot-current {
		width: 12px;
		height: 12px;
	}

	.turn-body {
		padding: 4px 0;
		min-width: 0;
	}

	.turn-preview {
		font-size: 12.5px;
		color: var(--ink-2);
		font-weight: 400;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.turn-preview-current {
		color: var(--ink);
		font-weight: 600;
	}

	.turn-time {
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.06em;
		margin-top: 1px;
	}

	@media (max-width: 960px) {
		.body {
			grid-template-columns: 1fr;
		}
		.right-panel {
			border-left: none;
			border-top: 1px solid var(--rule-soft);
			max-height: 40vh;
		}
	}

	@media (max-width: 640px) {
		.back-btn {
			padding: 0 12px;
		}
		.title-block {
			padding: 12px 14px;
			gap: 10px;
			flex-wrap: wrap;
		}
		.title,
		.title-input {
			font-size: 19px;
		}
		.input-wrap {
			padding: 10px 14px 14px;
		}
		.dispatch {
			padding: 0 16px;
		}
		.right-panel {
			max-height: 50vh;
		}
		.panel-body {
			padding: 16px 14px;
		}
	}

	.aux-running {
		margin: 0.5rem 1rem;
		padding: 0.55rem 0.7rem;
		border-left: 3px solid var(--accent);
		background: var(--paper-2);
		color: var(--ink-2);
		font-size: 0.78rem;
	}

	.load-error {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 16px;
		color: var(--err);
		font-size: 13px;
	}
</style>
