<script lang="ts">
	import type { ClusterModelInfo, ModelRoutingInfo, RouteSupplyInfo } from "@bound/client";
	import { Cpu, Pin } from "lucide-svelte";
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

	const { modelHint = undefined } = $props<{ modelHint?: string | null }>();

	// Selected logical model id (spec §9.1: the picker chooses a logical model by
	// display name; concrete routes appear only in the popover's route-pin section).
	let selectedModel = $state("");
	let models = $state<ClusterModelInfo[]>([]);
	let options = $state<ModelOption[]>([]);
	let routing = $state<ModelRoutingInfo[]>([]);
	let pinnedRoute = $state("");
	let hintApplied = $state(false);

	let open = $state(false);
	let openUp = $state(false);
	let activeIndex = $state(0);
	let hoverModel = $state<string | null>(null);
	let rootEl: HTMLDivElement | undefined = $state(undefined);
	let triggerEl: HTMLButtonElement | undefined = $state(undefined);
	let listEl: HTMLUListElement | undefined = $state(undefined);
	let typeahead = "";
	let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;

	const labels = $derived(buildModelLabels(routing));

	onMount(() => {
		void (async () => {
			try {
				const [data, routingData] = await Promise.all([
					client.listModels(),
					// Best-effort: an older server without the routing API leaves dots grey.
					client.getRoutingModels().catch(() => ({ models: [] })),
				]);
				models = data.models;
				routing = routingData.models;
				options = buildModelOptions(models, routing);
				const resolved = resolveInitialModel(options, models, data.default, modelHint);
				selectedModel = resolved.selectedModel;
				modelStore.setModel(resolved.modelId);
				if (modelHint && logicalModelFor(modelHint, options, models)) hintApplied = true;
			} catch (error) {
				console.error("Failed to load models:", error);
			}
		})();
		const onDocDown = (e: MouseEvent) => {
			if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
		};
		document.addEventListener("mousedown", onDocDown);
		return () => document.removeEventListener("mousedown", onDocDown);
	});

	// Late hint: LineView may deliver the thread's model_hint after models load.
	$effect(() => {
		if (modelHint && options.length > 0 && !hintApplied) {
			const logical = logicalModelFor(modelHint, options, models);
			if (logical) {
				selectedModel = logical;
				modelStore.setModel(logical);
				hintApplied = true;
			}
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
		if (r.drained) return "disabled";
		return r.health === "half_open" ? "half-open" : r.health;
	}

	function routeLine(r: RouteSupplyInfo): string {
		return `${labels.routeLabel(r.route_id)} on ${r.host_name}`;
	}

	const selectedLabel = $derived(
		options.find((o) => o.id === selectedModel)?.label ?? selectedModel,
	);
	const selectedRoutes = $derived(routesFor(selectedModel));
	const pinnedLabel = $derived.by(() => {
		const r = selectedRoutes.find((x) => x.route_id === pinnedRoute);
		return r ? routeLine(r) : null;
	});

	function openList(): void {
		if (options.length === 0) return;
		activeIndex = Math.max(
			0,
			options.findIndex((o) => o.id === selectedModel),
		);
		if (triggerEl && typeof window !== "undefined") {
			const rect = triggerEl.getBoundingClientRect();
			const below = window.innerHeight - rect.bottom;
			openUp = below < 320 && rect.top > below;
		}
		open = true;
		queueMicrotask(() => scrollActiveIntoView());
	}

	function close(focusTrigger = true): void {
		open = false;
		hoverModel = null;
		if (focusTrigger) triggerEl?.focus();
	}

	function choose(id: string): void {
		if (id !== selectedModel) pinnedRoute = "";
		selectedModel = id;
		modelStore.setModel(id);
		close();
	}

	function scrollActiveIntoView(): void {
		const el = listEl?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
		el?.scrollIntoView?.({ block: "nearest" });
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
			case "Tab":
				if (e.key === "Escape") e.preventDefault();
				close(e.key === "Escape");
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

<div class="model-selector" bind:this={rootEl}>
	<span class="icon" aria-hidden="true"><Cpu size={14} /></span>
	<button
		id="model"
		type="button"
		class="trigger"
		class:pinned={!!pinnedLabel}
		bind:this={triggerEl}
		role="combobox"
		aria-label="Model"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls="model-listbox"
		aria-activedescendant={open ? `model-opt-${activeIndex}` : undefined}
		data-value={selectedModel}
		title={pinnedLabel ? `Pinned to ${pinnedLabel}` : undefined}
		onclick={() => (open ? close() : openList())}
		onkeydown={onKeydown}
	>
		<ModelHealthDot state={healthFor(selectedModel)} />
		<span class="trigger-label">{selectedLabel || "\u2014"}</span>
		{#if pinnedLabel}
			<span class="pin-badge" aria-label="Route pinned"><Pin size={11} /></span>
		{/if}
		<span class="caret" aria-hidden="true">{open ? "\u25b4" : "\u25be"}</span>
	</button>

	{#if open}
		<div class="popover" class:up={openUp}>
			<ul id="model-listbox" class="listbox" role="listbox" aria-label="Models" bind:this={listEl}>
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
						<span
							class="dot-wrap"
							role="presentation"
							onmouseenter={() => (hoverModel = option.id)}
							onmouseleave={() => (hoverModel = null)}
						>
							<ModelHealthDot state={healthFor(option.id)} />
							{#if hoverModel === option.id && routesFor(option.id).length > 0}
								<span class="route-tip" role="tooltip">
									{#each routesFor(option.id) as r (r.route_id)}
										<span class="route-line" class:disabled={r.drained}>
											<span class="mono">{routeLine(r)}</span>
											<span class="route-health {r.drained ? 'drained' : r.health}"
												>{healthText(r)}</span
											>
										</span>
									{/each}
								</span>
							{/if}
						</span>
						<span class="option-label">{option.label}</span>
					</li>
				{/each}
			</ul>
			{#if selectedRoutes.length > 0}
				<div class="pin-section" role="group" aria-label="Route pin">
					<div class="kicker">Route for {selectedLabel}</div>
					<button
						type="button"
						class="pin-choice"
						class:selected={pinnedRoute === ""}
						aria-pressed={pinnedRoute === ""}
						onclick={() => (pinnedRoute = "")}>Auto</button
					>
					{#each selectedRoutes as r (r.route_id)}
						<button
							type="button"
							class="pin-choice mono"
							class:selected={pinnedRoute === r.route_id}
							aria-pressed={pinnedRoute === r.route_id}
							disabled={r.drained}
							onclick={() => (pinnedRoute = r.route_id)}>{routeLine(r)}</button
						>
					{/each}
				</div>
			{/if}
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

	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
		border: 1px solid var(--rule-soft);
		background: transparent;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 0;
		max-width: 280px;
		transition: border-color 0.2s ease;
	}

	.trigger:hover,
	.trigger:focus-visible,
	.trigger[aria-expanded="true"] {
		outline: none;
		border-color: var(--ink);
	}

	.trigger.pinned {
		border-style: dashed;
	}

	.trigger-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pin-badge {
		display: inline-flex;
		color: var(--warn);
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
		min-width: 260px;
		max-width: 380px;
		background: var(--paper, var(--bg));
		border: 1px solid var(--ink);
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
	}

	.popover.up {
		top: auto;
		bottom: calc(100% + 4px);
	}

	.listbox {
		list-style: none;
		margin: 0;
		padding: 4px 0;
		max-height: 280px;
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

	.dot-wrap {
		position: relative;
		display: inline-flex;
	}

	.route-tip {
		position: absolute;
		left: 14px;
		top: -4px;
		z-index: 41;
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 6px 8px;
		background: var(--ink);
		color: var(--paper, #fff);
		font-size: 11px;
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

	.pin-section {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 10px;
		border-top: 1px solid var(--rule-soft);
	}

	.kicker {
		width: 100%;
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-4);
	}

	.pin-choice {
		padding: 3px 8px;
		border: 1px solid var(--rule-soft);
		background: transparent;
		color: var(--ink-2);
		font-size: 11px;
		cursor: pointer;
		border-radius: 0;
	}

	.pin-choice.selected {
		border-color: var(--ink);
		color: var(--ink);
		font-weight: 700;
	}

	.pin-choice:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.mono {
		font-family: var(--font-mono);
	}
</style>
