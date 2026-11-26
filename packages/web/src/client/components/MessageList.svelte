<script lang="ts">
	import type { TurnProvenanceInfo } from "@bound/client";
	import { onMount, tick } from "svelte";
	import { fmtHhmm } from "../lib/format-time";
	import type { McpAppInstance } from "../lib/mcp-app-store";
	import {
		type DisplayItem as GroupedDisplayItem,
		groupMessages,
		toolUseIdsInItem,
	} from "../lib/message-grouping";
	import { anchorYardTrees } from "../lib/yard-anchoring";
	import type { YardTreeSnapshot } from "../lib/yard-execution";
	import McpAppPanel from "./McpAppPanel.svelte";
	import McpChallengeCard from "./McpChallengeCard.svelte";
	import MessageBubble from "./MessageBubble.svelte";
	import ModelSubstitutionNotice from "./ModelSubstitutionNotice.svelte";
	import ReasoningBlock from "./ReasoningBlock.svelte";
	import RouteFailoverNotice from "./RouteFailoverNotice.svelte";
	import ToolCallCard from "./ToolCallCard.svelte";
	import YardExecutionPanel from "./YardExecutionPanel.svelte";

	interface Message {
		role: string;
		content: string;
		tool_name?: string | null;
		model_id?: string | null;
		created_at?: string;
		id?: string;
		exit_code?: number | null;
		metadata?: string | Record<string, unknown> | null;
	}

	interface TurnRange {
		from: string;
		to: string | null;
	}

	// A one-shot scroll request from the context panel (turn click). `nonce` bumps
	// on every click so repeat-clicks on the same message re-fire the scroll.
	interface ScrollRequest {
		messageId: string;
		nonce: number;
	}

	interface Props {
		messages: Message[];
		waiting?: boolean;
		streamingText?: string;
		streamingReasoning?: string;
		emptyText?: string | null;
		turnRange?: TurnRange | null;
		scrollRequest?: ScrollRequest | null;
		threadColor?: number;
		/** The thread owner's display name — labels user rows stamped before `user_name` (#258). */
		userDisplayName?: string | null;
		lineColor?: string;
		isAgentActive?: boolean;
		appInstances?: McpAppInstance[];
		yardTrees?: YardTreeSnapshot[];
		/** Per-turn provenance (2026-11-21-model-routing.md §9.1), oldest-first. Each
		 * assistant message mounts a footer for the turn that answered it. */
		turnProvenance?: TurnProvenanceInfo[];
		/** RouteId → `provider:model` label and friendly host name, for the header note tooltip. */
		describeRoute?: (routeId: string | null) => { label: string; host: string | null };
		/** Logical model id → user-facing display name (spec §2.1); the footer shows this, never the id. */
		modelDisplay?: (modelId: string | null) => string;
		/** Thread-level route-failover notice (§9.2), or null when not failing over. */
		routeFailover?: {
			failedRoute: string;
			failedCount: number;
			windowSize: number;
			servingRoute: string;
		} | null;
		/** Thread-level model-substitution notice (§9.2), or null when none active. */
		modelSubstitution?: {
			original: string;
			substitute: string | null;
			category: string | null;
			explanation: string | null;
		} | null;
		/** Clears an active substitution pin; wired to the notice's retry action. */
		onRetrySubstitution?: () => void;
	}

	const {
		messages,
		waiting = false,
		streamingText = "",
		streamingReasoning = "",
		emptyText = null,
		turnRange = null,
		scrollRequest = null,
		threadColor = 0,
		userDisplayName = null,
		lineColor = "#999",
		isAgentActive = false,
		appInstances = [],
		yardTrees = [],
		turnProvenance = [],
		describeRoute = (routeId: string | null) => ({ label: routeId ?? "\u2014", host: null }),
		modelDisplay = (modelId: string | null) => modelId ?? "\u2014",
		routeFailover = null,
		modelSubstitution = null,
		onRetrySubstitution = undefined,
	}: Props = $props();

	// --- Auto-scroll logic ---
	let scrollContainer = $state<HTMLDivElement | null>(null);
	let prevMessageCount = 0;
	let isAtBottom = true;
	const BOTTOM_THRESHOLD = 80;

	function checkIsAtBottom(): boolean {
		if (!scrollContainer) return true;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
	}

	function scrollToBottom(smooth = true): void {
		if (!scrollContainer) return;
		requestAnimationFrame(() => {
			if (!scrollContainer) return;
			scrollContainer.scrollTo({
				// Read scrollHeight inside the frame (#241): content can grow
				// between the call and the frame it lands in (streaming chunks,
				// async markdown/mermaid, trailing yard/MCP panels relocating
				// when their source row arrives), and a target captured at call
				// time strands the viewport above the new bottom.
				top: scrollContainer.scrollHeight,
				behavior: smooth ? "smooth" : "instant",
			});
		});
	}

	function handleScroll(): void {
		isAtBottom = checkIsAtBottom();
	}

	onMount(() => {
		// Initial position: instant. There is nothing to animate to on load, and
		// a smooth glide from the top is visible garbage on long threads.
		tick().then(() => scrollToBottom(false));

		// #241: async content growth changes scrollHeight WITHOUT a
		// messages.length change — content-visibility rows realizing their real
		// heights (#175), async markdown/mermaid, a trailing yard/MCP panel
		// relocating when its source row arrives — so the count-based effect
		// never re-fires and the viewport drifts up off the bottom. Re-pin the
		// viewport whenever the scroller's box changes while the user is at the
		// bottom: the same invariant the count effect enforces for appends,
		// extended to growth the effect cannot see. Instant, not smooth — this
		// is correction, not motion. `isAtBottom` is maintained by handleScroll,
		// so a viewport that left the bottom (user scroll, or the scroll event
		// a pinned re-layout naturally emits) is never yanked back down.
		if (scrollContainer) {
			const ro = new ResizeObserver(() => {
				if (scrollContainer && isAtBottom) {
					scrollContainer.scrollTop = scrollContainer.scrollHeight;
				}
			});
			ro.observe(scrollContainer);
			return () => ro.disconnect();
		}
	});

	$effect(() => {
		const count = messages.length;
		if (count === prevMessageCount) return;

		const lastMsg = messages[count - 1];
		const isNewUserMessage = lastMsg?.role === "user";

		if (isNewUserMessage || isAtBottom) {
			tick().then(() => scrollToBottom());
		}

		prevMessageCount = count;
	});

	// Auto-scroll during streaming when user is already at the bottom
	$effect(() => {
		if (streamingText && isAtBottom) {
			tick().then(() => scrollToBottom(false));
		}
	});

	// --- Turn range highlighting + scroll ---
	function tsInRange(ts: string | undefined, range: TurnRange): boolean {
		if (!ts) return false;
		if (ts < range.from) return false;
		if (range.to !== null && ts >= range.to) return false;
		return true;
	}

	let prevTurnFrom: string | null = null;
	$effect(() => {
		const from = turnRange?.from ?? null;
		if (from === prevTurnFrom) return;
		prevTurnFrom = from;
		if (!from || !scrollContainer) return;

		tick().then(() => {
			requestAnimationFrame(() => {
				if (!scrollContainer) return;
				const target = scrollContainer.querySelector("[data-turn-active]") as HTMLElement | null;
				if (target) {
					const containerTop = scrollContainer.getBoundingClientRect().top;
					const targetTop = target.getBoundingClientRect().top;
					const offset = targetTop - containerTop + scrollContainer.scrollTop - 12;
					scrollContainer.scrollTo({ top: offset, behavior: "smooth" });
				}
			});
		});
	});

	// --- Scroll-to-message (context-panel turn click) ---
	// Mirrors the turn-range scroll above but keys off a specific message id and
	// deliberately does NOT set `turnRange`, so no rows are dimmed — just a jump.
	let prevScrollNonce = -1;
	$effect(() => {
		const req = scrollRequest;
		if (!req || req.nonce === prevScrollNonce) return;
		prevScrollNonce = req.nonce;
		if (!scrollContainer) return;
		const { messageId } = req;
		const selectorId =
			typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? CSS.escape(messageId)
				: messageId;
		tick().then(() => {
			requestAnimationFrame(() => {
				if (!scrollContainer) return;
				const target = scrollContainer.querySelector(
					`[data-message-id="${selectorId}"]`,
				) as HTMLElement | null;
				if (!target) return;
				const containerTop = scrollContainer.getBoundingClientRect().top;
				const targetTop = target.getBoundingClientRect().top;
				const offset = targetTop - containerTop + scrollContainer.scrollTop - 12;
				scrollContainer.scrollTo({ top: offset, behavior: "smooth" });
			});
		});
	});

	// Build a lookup from tool_use id → tool_result message so ToolCallCard can
	// surface the result inline beneath its originating tool_use row.
	interface ToolResultMsg {
		content: string;
		exit_code?: number | null;
		tool_name?: string | null;
		metadata?: string | Record<string, unknown> | null;
	}

	const resultsByToolUseId = $derived.by((): Record<string, ToolResultMsg> => {
		const map: Record<string, ToolResultMsg> = {};
		for (const m of messages) {
			if (m.role === "tool_result" && m.tool_name) {
				map[m.tool_name] = {
					content: m.content,
					exit_code: m.exit_code ?? null,
					tool_name: m.tool_name,
					metadata: m.metadata ?? null,
				};
			}
		}
		return map;
	});

	// Group consecutive tool_call messages into a single display item. The pure
	// grouping logic (incl. issue #66's break-on-user-facing-text rule) lives in
	// ../lib/message-grouping so it can be unit-tested without mounting the view.
	type DisplayItem = GroupedDisplayItem<Message>;

	const displayItems = $derived.by((): DisplayItem[] => groupMessages(messages));

	// Lifecycle events can precede their persisted tool_call. Keep unmatched trees
	// trailing until polling supplies their source row, then relocate every trace for that call.
	const anchoredYardTrees = $derived.by(() =>
		anchorYardTrees(
			yardTrees,
			displayItems.map((item) => ({ key: item.key, toolCallIds: toolUseIdsInItem(item) })),
		),
	);

	// Anchor each live MCP App panel beneath the display item carrying the tool_use
	// that spawned it (instance.callId === the persisted tool_use.id). `perItem`
	// keys panels by display-item key for inline render; `trailing` holds instances
	// with no matching item yet — in-flight calls whose tool_call message hasn't
	// streamed in — which fall to the end of the stream until their row arrives.
	const anchoredInstances = $derived.by(
		(): {
			perItem: Map<string, McpAppInstance[]>;
			trailing: McpAppInstance[];
		} => {
			const byCallId = new Map<string, McpAppInstance>();
			for (const inst of appInstances) byCallId.set(inst.callId, inst);
			const perItem = new Map<string, McpAppInstance[]>();
			const placed = new Set<string>();
			for (const item of displayItems) {
				const matched: McpAppInstance[] = [];
				for (const id of toolUseIdsInItem(item)) {
					const inst = byCallId.get(id);
					if (inst && !placed.has(id)) {
						matched.push(inst);
						placed.add(id);
					}
				}
				if (matched.length) perItem.set(item.key, matched);
			}
			const trailing = appInstances.filter((inst) => !placed.has(inst.callId));
			return { perItem, trailing };
		},
	);

	// Match each assistant message to the turn that answered it (§9.1). A turn's
	// `created_at` lands at or just before its answering assistant message; attach
	// the latest turn whose timestamp is ≤ the message and still after any earlier
	// assistant message, so each turn footers exactly one assistant row. Messages
	// without a created_at or with no eligible turn carry no footer.
	const provenanceByMessageId = $derived.by((): Map<string, TurnProvenanceInfo> => {
		const out = new Map<string, TurnProvenanceInfo>();
		if (turnProvenance.length === 0) return out;
		// Turns oldest-first (the server returns them that way); assistant messages in
		// timeline order. Walk both: assign each turn to the first later assistant
		// message not yet claimed.
		const turnsAsc = [...turnProvenance].sort((a, b) =>
			a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
		);
		const assistants = messages.filter((m) => m.role === "assistant" && m.id && m.created_at);
		let mi = 0;
		for (const t of turnsAsc) {
			while (mi < assistants.length && (assistants[mi].created_at ?? "") < t.created_at) mi++;
			if (mi >= assistants.length) break;
			const msg = assistants[mi];
			if (msg.id) out.set(msg.id, t);
			mi++;
		}
		return out;
	});

	function provenanceForItem(item: DisplayItem): TurnProvenanceInfo | null {
		if (item.kind !== "message") return null;
		if (item.msg.role !== "assistant") return null;
		const id = item.msg.id;
		return id ? (provenanceByMessageId.get(id) ?? null) : null;
	}

	/**
	 * Quiet header annotation beside the model name, shown only when it says
	 * something the model name does not: a refusal/substitution fallback, or a
	 * turn that failed over off its first route. Tooltip carries the route label,
	 * host, and attempts.
	 */
	function noteForItem(item: DisplayItem): { text: string; title: string } | null {
		const prov = provenanceForItem(item);
		if (!prov) return null;
		const served = describeRoute(prov.route_id);
		const lines = [`${served.label}${served.host ? ` on ${served.host}` : ""}`];
		for (const a of prov.attempts ?? []) {
			const r = describeRoute(a.route_id);
			const outcome =
				a.outcome === "ok" ? "served" : a.outcome === "refusal" ? "refused" : "failed";
			lines.push(
				`${modelDisplay(a.model_id)} · ${r.label}${r.host ? ` on ${r.host}` : ""} · ${outcome}`,
			);
		}
		const title = lines.join("\n");
		if (prov.substituted_from) {
			return { text: `· fallback from ${modelDisplay(prov.substituted_from)}`, title };
		}
		if ((prov.attempts ?? []).some((a) => a.outcome === "route-error") && served.host) {
			return { text: `· via ${served.host}`, title };
		}
		return null;
	}

	function isItemInRange(item: DisplayItem): boolean {
		if (!turnRange) return true;
		if (item.kind === "toolGroup") {
			return item.timestamps.some((ts) => tsInRange(ts, turnRange));
		}
		return tsInRange(item.earliest, turnRange);
	}

	// Render time as HH:MM in the local timezone — matches the reference
	// signage aesthetic (tabular-numeric mono, 24-hour).
	function dotKind(item: DisplayItem): "user" | "assistant" | "alert" | "system" {
		if (item.kind === "toolGroup") return "assistant";
		const role = item.msg.role;
		if (role === "user") return "user";
		if (role === "alert") return "alert";
		if (role === "system") return "system";
		return "assistant";
	}
</script>

<div class="board">
	<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
		<McpChallengeCard />
		{#snippet yardPanelRow(tree: YardTreeSnapshot)}
			<div class="turn-row" data-message-role="tool_call">
				<div class="time-gutter mono"></div>
				<div class="rail">
					<div class="rail-line" style="background: {lineColor}"></div>
					<div
						class="rail-dot rail-dot-assistant"
						style="background: {lineColor}; border-color: {lineColor}"
					></div>
				</div>
				<div class="row-content"><YardExecutionPanel {tree} /></div>
			</div>
		{/snippet}
		{#snippet panelRow(instance: McpAppInstance)}
			<div class="turn-row" data-message-role="tool_call">
				<div class="time-gutter mono"></div>
				<div class="rail">
					<div class="rail-line" style="background: {lineColor}"></div>
					<div
						class="rail-dot rail-dot-assistant"
						style="background: {lineColor}; border-color: {lineColor}"
					></div>
				</div>
				<div class="row-content">
					<McpAppPanel {instance} />
				</div>
			</div>
		{/snippet}
		{#if displayItems.length === 0 && emptyText}
			<div class="empty-state">
				<p>{emptyText}</p>
			</div>
		{:else}
			{#each displayItems as item, i (item.key)}
				{@const active = isItemInRange(item)}
				{@const kind = dotKind(item)}
				{@const isFirst = i === 0}
				<div
					class="turn-row"
					class:dimmed={turnRange !== null && !active}
					data-turn-active={active && turnRange ? "" : undefined}
					data-message-id={item.kind === "message" ? item.msg.id : undefined}
					data-message-role={item.kind === "message" ? item.msg.role : "tool_call"}
				>
					<div class="time-gutter mono">{fmtHhmm(item.earliest)}</div>
					<div class="rail">
						<div class="rail-line" style="background: {lineColor}"></div>
						{#if isFirst}
							<div class="rail-cap"></div>
						{/if}
						<div
							class="rail-dot rail-dot-{kind}"
							style={kind === "assistant"
								? `background: ${lineColor}; border-color: ${lineColor}`
								: ""}
						></div>
					</div>
					<div class="row-content">
						{#if item.kind === "toolGroup"}
							<ToolCallCard
								messages={item.messages}
								{resultsByToolUseId}
								{lineColor}
								{modelDisplay}
							/>
						{:else}
							{@const note = noteForItem(item)}
							<MessageBubble
								role={item.msg.role as
									"user" | "assistant" | "system" | "alert" | "tool_call" | "tool_result"}
								content={item.msg.content}
								toolName={item.msg.tool_name}
								modelId={item.msg.model_id ? modelDisplay(item.msg.model_id) : null}
								modelNote={note?.text ?? null}
								modelNoteTitle={note?.title ?? null}
								exitCode={item.msg.exit_code}
								metadata={item.msg.metadata ?? null}
								{userDisplayName}
								{threadColor}
							/>
						{/if}
					</div>
				</div>
				{#each anchoredYardTrees.perItem.get(item.key) ?? [] as tree (tree.traceId)}
					{@render yardPanelRow(tree)}
				{/each}
				{#each anchoredInstances.perItem.get(item.key) ?? [] as instance (instance.callId)}
					{@render panelRow(instance)}
				{/each}
			{/each}
		{/if}
		{#if waiting || isAgentActive}
			<div class="turn-row thinking-row">
				<div class="time-gutter"></div>
				<div class="rail">
					<div class="rail-line rail-line-dashed" style="border-left-color: {lineColor}"></div>
					<div class="rail-dot rail-dot-pulsing" style="border-color: {lineColor}"></div>
				</div>
				<div class="row-content">
					{#if streamingReasoning}
						<ReasoningBlock text={streamingReasoning} {lineColor} />
					{/if}
					{#if streamingText}
						<MessageBubble role="assistant" content={streamingText} {threadColor} />
					{:else if !streamingReasoning}
						<div class="role-label">Agent</div>
						<div class="thinking-caption">
							<span>Thinking</span>
							<span class="dots">
								<span class="dot"></span>
								<span class="dot"></span>
								<span class="dot"></span>
							</span>
						</div>
					{/if}
				</div>
			</div>
		{/if}
		{#each anchoredYardTrees.trailing as tree (tree.traceId)}
			{@render yardPanelRow(tree)}
		{/each}
		{#each anchoredInstances.trailing as instance (instance.callId)}
			{@render panelRow(instance)}
		{/each}
		{#if routeFailover || modelSubstitution}
			<div class="thread-notices">
				{#if routeFailover}
					<RouteFailoverNotice
						failedRoute={routeFailover.failedRoute}
						failedCount={routeFailover.failedCount}
						windowSize={routeFailover.windowSize}
						servingRoute={routeFailover.servingRoute}
					/>
				{/if}
				{#if modelSubstitution}
					<ModelSubstitutionNotice
						original={modelSubstitution.original}
						substitute={modelSubstitution.substitute}
						category={modelSubstitution.category}
						explanation={modelSubstitution.explanation}
						onRetry={onRetrySubstitution}
					/>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.board {
		background: var(--paper);
		border: none;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		position: relative;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 24px 36px 0 36px;
		min-height: 0;
		position: relative;
	}

	.messages::after {
		content: "";
		display: block;
		height: 32px;
		flex-shrink: 0;
	}

	/* Per-turn grid: 70px time gutter | 32px rail | 1fr content.
	 * Each row owns its own rail so the vertical track is contiguous across
	 * consecutive rows, while the dot punches over the line via a paper
	 * box-shadow ring. */
	.turn-row {
		display: grid;
		grid-template-columns: 70px 32px 1fr;
		column-gap: 18px;
		align-items: flex-start;
		position: relative;
		transition: opacity 0.3s ease;
		/* #175: skip layout + paint for rows outside the viewport. On a thread
		 * with 1k+ turns, a window resize otherwise reflows every row
		 * synchronously, which is the reported lag; content-visibility scopes
		 * the reflow to on-screen rows only. `contain-intrinsic-size: auto <len>`
		 * reserves a placeholder height for not-yet-rendered rows (keeping the
		 * scrollbar stable) and the `auto` keyword makes the browser remember
		 * each row's real height once measured, so scroll position stays
		 * accurate after a row has been seen. Rows stay in the DOM, so
		 * querySelector / getBoundingClientRect (turn-scroll and MCP-panel
		 * anchoring above) are unaffected. */
		content-visibility: auto;
		contain-intrinsic-size: auto 96px;
	}

	.turn-row.dimmed {
		opacity: 0.32;
	}

	.time-gutter {
		text-align: right;
		padding-top: 6px;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 12px;
		color: var(--ink-2);
		letter-spacing: 0.02em;
	}

	.rail {
		position: relative;
		align-self: stretch;
		display: flex;
		justify-content: center;
		min-height: 36px;
	}

	.rail-line {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 4px;
		left: 50%;
		transform: translateX(-50%);
	}

	.rail-line-dashed {
		background: transparent;
		border-left: 4px dashed;
		opacity: 0.45;
		width: 0;
	}

	/* Paper cap hides the rail above the first dot so the line doesn't
	 * extend past the top of the thread. */
	.rail-cap {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 14px;
		background: var(--paper);
		z-index: 1;
	}

	.rail-dot {
		position: relative;
		z-index: 2;
		margin-top: 12px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 3px solid;
		box-shadow: 0 0 0 4px var(--paper);
		flex-shrink: 0;
	}

	.rail-dot-user {
		background: var(--ink);
		border-color: var(--ink);
	}

	.rail-dot-alert {
		background: var(--accent);
		border-color: var(--accent);
	}

	.rail-dot-system {
		background: var(--ink-3);
		border-color: var(--ink-3);
	}

	.rail-dot-pulsing {
		background: var(--paper);
		animation: rail-dot-pulse 1.4s ease-in-out infinite;
	}

	@keyframes rail-dot-pulse {
		0%,
		100% {
			transform: scale(1);
			opacity: 1;
		}
		50% {
			transform: scale(1.15);
			opacity: 0.7;
		}
	}

	.row-content {
		min-width: 0;
	}

	.thinking-row {
		padding-bottom: 20px;
	}

	.role-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-2);
		margin-bottom: 4px;
	}

	.thinking-caption {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.dots {
		display: inline-flex;
		gap: 3px;
	}

	.dots .dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--ink-3);
		animation: thinking-dot 1.4s ease-in-out infinite;
	}

	.dots .dot:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dots .dot:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes thinking-dot {
		0%,
		80%,
		100% {
			opacity: 0.3;
			transform: scale(0.85);
		}
		40% {
			opacity: 1;
			transform: scale(1);
		}
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--ink-4);
		font-family: var(--font-display);
		font-size: 13px;
		font-style: italic;
	}

	@media (prefers-reduced-motion: reduce) {
		.rail-dot-pulsing {
			animation: none;
		}
		.dots .dot {
			animation: none;
		}
		.messages {
			scroll-behavior: auto;
		}
	}
</style>
