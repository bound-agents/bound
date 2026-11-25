<script lang="ts">
	import type { ClusterModelInfo, ModelRoutingInfo, RouteSupplyInfo } from "@bound/client";
	import { Cpu } from "lucide-svelte";
	import { onMount } from "svelte";
	import { client } from "../lib/bound";
	import {
		type ModelOption,
		buildModelOptions,
		logicalModelFor,
		resolveInitialModel,
	} from "../lib/model-hint";
	import { buildModelLabels } from "../lib/model-labels";
	import { modelStore } from "../lib/modelStore";
	import ModelHealthDot from "./ModelHealthDot.svelte";

	const {
		modelHint = undefined,
		fallbackModel = undefined,
		onselect = undefined,
	} = $props<{
		modelHint?: string | null;
		fallbackModel?: string | null;
		/** Fires only on an explicit operator pick, never on the initial prefill. */
		onselect?: (modelId: string) => void;
	}>();

	// Selected logical model id (spec §9.1: the picker chooses a logical model by
	// display name; concrete routes appear only in the status-dot route tooltip).
	let selectedModel = $state("");
	let models = $state<ClusterModelInfo[]>([]);
	let options = $state<ModelOption[]>([]);
	let routing = $state<ModelRoutingInfo[]>([]);
	let hintApplied = $state(false);

	let open = $state(false);
	let openUp = $state(false);
	let activeIndex = $state(0);
	let rootEl: HTMLDivElement | undefined = $state(undefined);
	let triggerEl: HTMLButtonElement | undefined = $state(undefined);
	let listEl: HTMLUListElement | undefined = $state(undefined);
	let popEl: HTMLDivElement | undefined = $state(undefined);
	let dotBtn: HTMLButtonElement | undefined = $state(undefined);
	let tipVisible = $state(false);
	let tipLeft = $state(0);
	let tipTop = $state(0);
	let tipUp = $state(false);
	let typeahead = "";
	let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;
	const TIP_WIDTH = 320;
	const TIP_GAP = 6;
	const POPOVER_ESTIMATE = 360;

	const labels = $derived(buildModelLabels(routing));

	onMount(() => {
		void (async () => {
			try {
				const [data, routingData, defaults] = await Promise.all([
					client.listModels(),
					// Best-effort: an older server without the routing API leaves dots grey.
					client.getRoutingModels().catch(() => ({ models: [] })),
					client.getClusterDefaults().catch(() => null),
				]);
				models = data.models;
				routing = routingData.models;
				options = buildModelOptions(models, routing);
				const resolved = resolveInitialModel(options, models, data.default, modelHint, {
					fallbackModel,
					clusterDefault: defaults?.roles?.default ?? null,
					routing,
				});
				selectedModel = resolved.selectedModel;
				modelStore.setModel(resolved.modelId);
				if (modelHint && logicalModelFor(modelHint, options, models, routing)) hintApplied = true;
			} catch (error) {
				console.error("Failed to load models:", error);
			}
		})();
		const onDocDown = (e: MouseEvent) => {
			if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
		};
		const hideTip = () => {
			tipVisible = false;
		};
		document.addEventListener("mousedown", onDocDown);
		window.addEventListener("scroll", hideTip, true);
		window.addEventListener("resize", hideTip);
		const healthTimer = setInterval(() => void refreshRouting(), ROUTING_REFRESH_MS);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			window.removeEventListener("scroll", hideTip, true);
			window.removeEventListener("resize", hideTip);
			clearInterval(healthTimer);
			if (typeaheadTimer) clearTimeout(typeaheadTimer);
		};
	});

	// Route health is reported by each serving host and changes over time; keep the
	// dots current while the picker stays mounted, and re-read on every open.
	const ROUTING_REFRESH_MS = 60_000;
	let routingRefreshInFlight = false;

	async function refreshRouting(): Promise<void> {
		if (routingRefreshInFlight) return;
		routingRefreshInFlight = true;
		try {
			routing = (await client.getRoutingModels()).models;
		} catch {
			// Keep the last snapshot.
		} finally {
			routingRefreshInFlight = false;
		}
	}

	// Late hint: LineView may deliver the thread's model_hint after models load.
	$effect(() => {
		if (modelHint && options.length > 0 && !hintApplied) {
			const logical = logicalModelFor(modelHint, options, models, routing);
			if (logical) {
				selectedModel = logical;
				modelStore.setModel(logical);
				hintApplied = true;
			}
		}
	});

	// Late fallback: the thread's messages often load after the model list, so a
	// hint-less thread must still adopt its latest message's model rather than
	// keep the host default it was prefilled with.
	let fallbackApplied = $state(false);
	let userPicked = false;
	$effect(() => {
		if (modelHint || userPicked || fallbackApplied || !fallbackModel || options.length === 0)
			return;
		const logical = logicalModelFor(fallbackModel, options, models, routing);
		if (logical) {
			selectedModel = logical;
			modelStore.setModel(logical);
			fallbackApplied = true;
		}
	});

	function routesFor(modelId: string): RouteSupplyInfo[] {
		return routing.find((m) => m.logical_model === modelId)?.routes ?? [];
	}

	// Three-state health: green if any live route is healthy, amber if only a
	// backoff/half-open route can serve, grey if none or unobservable (§9.1).
	function healthFor(modelId: string): "healthy" | "fallback" | "none" | "unknown" {
		const entry = routing.find((m) => m.logical_model === modelId);
		if (!entry) return "unknown";
		const live = entry.routes.filter((r) => !r.drained);
		if (live.length === 0) return "none";
		if (live.some((r) => r.health === "healthy")) return "healthy";
		if (live.some((r) => r.health === "backoff" || r.health === "half_open")) return "fallback";
		return "unknown";
	}

	function healthText(r: RouteSupplyInfo): string {
		if (r.drained) return "Disabled";
		if (r.health === "half_open") return "Retrying";
		if (r.health === "backoff") return "Backing off";
		if (r.health === "healthy") return "Healthy";
		return "Unknown";
	}

	function routeLine(r: RouteSupplyInfo): string {
		return `${labels.routeLabel(r.route_id)} on ${r.host_name}`;
	}

	const selectedLabel = $derived(
		options.find((o) => o.id === selectedModel)?.label ?? selectedModel,
	);
	const selectedRoutes = $derived(routesFor(selectedModel));

	function showTip(): void {
		if (!dotBtn || open || selectedRoutes.length === 0) return;
		const r = dotBtn.getBoundingClientRect();
		const estimate = 24 + selectedRoutes.length * 18;
		const below = window.innerHeight - r.bottom;
		tipUp = below < estimate + TIP_GAP && r.top > below;
		tipLeft = Math.min(Math.max(8, r.left), window.innerWidth - TIP_WIDTH - 8);
		tipTop = tipUp ? r.top - TIP_GAP : r.bottom + TIP_GAP;
		tipVisible = true;
	}

	function hideTip(): void {
		tipVisible = false;
	}

	let popMaxHeight = $state<number | null>(null);

	// The visible box the popover must fit in: the viewport intersected with every
	// clipping ancestor (the conversation column scrolls, so it clips).
	function clipBounds(el: HTMLElement): { top: number; bottom: number } {
		let top = 0;
		let bottom = window.innerHeight;
		for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
			const s = getComputedStyle(a);
			if (/(hidden|clip|scroll|auto)/.test(`${s.overflow} ${s.overflowY}`)) {
				const r = a.getBoundingClientRect();
				top = Math.max(top, r.top);
				bottom = Math.min(bottom, r.bottom);
			}
		}
		return { top, bottom };
	}

	function placePopover(): void {
		if (!triggerEl || !rootEl || typeof window === "undefined") return;
		const rect = triggerEl.getBoundingClientRect();
		const bounds = clipBounds(rootEl);
		const below = bounds.bottom - rect.bottom - 8;
		const above = rect.top - bounds.top - 8;
		const h = popEl?.scrollHeight ?? POPOVER_ESTIMATE;
		openUp = below < h && above > below;
		// Never taller than the room on the chosen side (short/mobile viewports).
		popMaxHeight = Math.max(120, Math.floor(openUp ? above : below));
	}

	function openList(): void {
		if (options.length === 0) return;
		tipVisible = false;
		activeIndex = Math.max(
			0,
			options.findIndex((o) => o.id === selectedModel),
		);
		placePopover();
		open = true;
		void refreshRouting();
		queueMicrotask(() => {
			// Re-measure with the real height.
			placePopover();
			scrollActiveIntoView();
		});
	}

	function close(focusTrigger = true): void {
		open = false;
		if (focusTrigger) triggerEl?.focus();
	}

	function onRootFocusOut(e: FocusEvent): void {
		const next = e.relatedTarget as Node | null;
		if (open && next && rootEl && !rootEl.contains(next)) close(false);
	}

	function choose(id: string): void {
		userPicked = true;
		selectedModel = id;
		modelStore.setModel(id);
		onselect?.(id);
		close();
	}

	// Scroll only the listbox: element.scrollIntoView would also scroll the page
	// (and the input bar with it) on short viewports.
	function scrollActiveIntoView(): void {
		const el = listEl?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
		if (!el || !listEl) return;
		const top = el.offsetTop;
		const bottom = top + el.offsetHeight;
		if (top < listEl.scrollTop) listEl.scrollTop = top;
		else if (bottom > listEl.scrollTop + listEl.clientHeight)
			listEl.scrollTop = bottom - listEl.clientHeight;
	}

	function move(to: number): void {
		if (options.length === 0) return;
		activeIndex = Math.min(options.length - 1, Math.max(0, to));
		scrollActiveIntoView();
	}

	function onKeydown(e: KeyboardEvent): void {
		if (!open) {
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
				e.preventDefault();
				openList();
			}
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				move(activeIndex + 1);
				return;
			case "ArrowUp":
				e.preventDefault();
				move(activeIndex - 1);
				return;
			case "Home":
				e.preventDefault();
				move(0);
				return;
			case "End":
				e.preventDefault();
				move(options.length - 1);
				return;
			case "Enter":
			case " ":
				e.preventDefault();
				if (options[activeIndex]) choose(options[activeIndex].id);
				return;
			case "Escape":
				e.preventDefault();
				close(true);
				return;
			case "Tab":
				// Tab leaves the popover; focusout closes it.
				return;
		}
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			typeahead += e.key.toLowerCase();
			if (typeaheadTimer) clearTimeout(typeaheadTimer);
			typeaheadTimer = setTimeout(() => {
				typeahead = "";
			}, 600);
			const idx = options.findIndex((o) => o.label.toLowerCase().startsWith(typeahead));
			if (idx >= 0) move(idx);
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="model-selector"
	bind:this={rootEl}
	onfocusout={onRootFocusOut}
	onkeydown={(e) => {
		if (e.key === "Escape" && tipVisible) hideTip();
	}}
>
	<span class="icon" aria-hidden="true"><Cpu size={14} /></span>
	<span class="control" class:active={open}>
		<button
			type="button"
			class="status-dot-btn"
			bind:this={dotBtn}
			aria-label="Routes for {selectedLabel || 'model'}"
			aria-describedby={tipVisible ? "model-routes-tip" : undefined}
			onmouseenter={showTip}
			onmouseleave={hideTip}
			onfocus={showTip}
			onblur={hideTip}
			onkeydown={(e) => {
				if (e.key === "Escape") hideTip();
			}}
		>
			<ModelHealthDot state={healthFor(selectedModel)} showTitle={false} />
		</button>
		<button
			id="model"
			type="button"
			class="trigger"
			bind:this={triggerEl}
			role="combobox"
			aria-label="Model"
			aria-haspopup="listbox"
			aria-expanded={open}
			aria-controls="model-listbox"
			aria-activedescendant={open ? `model-opt-${activeIndex}` : undefined}
			data-value={selectedModel}
			onclick={() => (open ? close() : openList())}
			onkeydown={onKeydown}
		>
			<span class="trigger-label">{selectedLabel || "\u2014"}</span>
			<span class="caret" aria-hidden="true">{open ? "\u25b4" : "\u25be"}</span>
		</button>
	</span>

	{#if tipVisible && !open}
		<span
			id="model-routes-tip"
			class="route-tip"
			class:up={tipUp}
			role="tooltip"
			style="left: {tipLeft}px; top: {tipTop}px; max-width: {TIP_WIDTH}px;"
		>
			{#each selectedRoutes as r (r.route_id)}
				<span class="route-line" class:disabled={r.drained}>
					<span class="mono">{routeLine(r)}</span>
					<span class="route-health {r.drained ? 'drained' : r.health}">{healthText(r)}</span>
				</span>
			{/each}
		</span>
	{/if}

	{#if open}
		<div
			class="popover"
			class:up={openUp}
			bind:this={popEl}
			role="presentation"
			onkeydown={(e) => {
				// Escape from anywhere in the popover closes it;
				// option keydowns already handled it and called preventDefault.
				if (e.key === "Escape" && !e.defaultPrevented) {
					e.preventDefault();
					close(true);
				}
			}}
			style={popMaxHeight ? `max-height: ${popMaxHeight}px` : undefined}
		>
			<ul
				id="model-listbox"
				class="listbox"
				role="listbox"
				aria-label="Models"
				tabindex="-1"
				bind:this={listEl}
			>
				{#each options as option, i (option.id)}
					<li
						id="model-opt-{i}"
						class="option"
						class:active={i === activeIndex}
						role="option"
						aria-selected={option.id === selectedModel}
						data-index={i}
						data-value={option.id}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => choose(option.id)}
						onmousemove={() => (activeIndex = i)}
						onkeydown={onKeydown}
					>
						<ModelHealthDot state={healthFor(option.id)} />
						<span class="option-label">{option.label}</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.model-selector {
		position: relative;
		display: inline-flex;
		gap: 8px;
		align-items: center;
	}

	.icon {
		display: flex;
		align-items: center;
		color: var(--ok);
	}

	.control {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--rule-soft);
		max-width: 300px;
		transition: border-color 0.2s ease;
	}

	.control:hover,
	.control:focus-within,
	.control.active {
		border-color: var(--ink);
	}

	.status-dot-btn {
		display: inline-flex;
		align-items: center;
		padding: 5px 2px 5px 10px;
		border: 0;
		background: transparent;
		cursor: help;
	}

	.status-dot-btn:focus-visible,
	.trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 5px 10px 5px 6px;
		border: 0;
		background: transparent;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 0;
	}

	.trigger-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.caret {
		color: var(--ink-4);
		font-size: 10px;
	}

	/* Absolutely positioned: opening never changes the input bar's height. */
	.popover {
		position: absolute;
		left: 0;
		top: calc(100% + 4px);
		z-index: 40;
		display: flex;
		flex-direction: column;
		min-width: 260px;
		max-width: min(380px, calc(100vw - 16px));
		background: var(--paper, var(--bg));
		border: 1px solid var(--ink);
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
	}

	.popover.up {
		top: auto;
		bottom: calc(100% + 4px);
	}

	.listbox {
		position: relative;
		list-style: none;
		margin: 0;
		padding: 4px 0;
		max-height: 280px;
		min-height: 60px;
		flex: 1 1 auto;
		overflow-y: auto;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
		font-family: var(--font-display);
		font-size: 12px;
		color: var(--ink-2);
		cursor: pointer;
	}

	.option.active {
		background: var(--rule-soft);
		color: var(--ink);
	}

	.option[aria-selected="true"] .option-label {
		font-weight: 700;
	}

	.route-tip {
		position: fixed;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 6px 8px;
		background: var(--ink);
		color: var(--paper, #fff);
		font-size: 11px;
		pointer-events: none;
	}

	.route-tip.up {
		transform: translateY(-100%);
	}

	.route-tip .mono {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.route-line {
		display: flex;
		gap: 8px;
		justify-content: space-between;
	}

	.route-line.disabled {
		opacity: 0.6;
		text-decoration: line-through;
	}

	.route-health.healthy {
		color: var(--ok);
	}

	.route-health.backoff,
	.route-health.half_open {
		color: var(--warn);
	}

	.kicker {
		width: 100%;
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-4);
	}

	.mono {
		font-family: var(--font-mono);
	}
</style>
