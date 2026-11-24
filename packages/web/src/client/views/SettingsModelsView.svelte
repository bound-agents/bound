<script lang="ts">
	import type {
		ClusterDefaultsResponse,
		FallbackPolicyInfo,
		ModelRoutingInfo,
		RouteSupplyInfo,
	} from "@bound/client";
	import { onMount } from "svelte";
	import Btn from "../components/Btn.svelte";
	import ModelHealthDot from "../components/ModelHealthDot.svelte";
	import Page from "../components/Page.svelte";
	import SectionHeader from "../components/SectionHeader.svelte";
	import { client } from "../lib/bound";

	// Settings › Models (2026-11-21-model-routing.md §9.3, 2026-11-21-model-catalog.md §9).
	// One operator page managing synced cluster routing preferences against the
	// read-only per-host route supply. Health is this host's router view; a remote
	// route reports "unknown" rather than a guessed verdict.

	let models = $state<ModelRoutingInfo[]>([]);
	let defaults = $state<ClusterDefaultsResponse | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	// Which logical models are expanded to show their route list.
	let expanded = $state<Set<string>>(new Set());

	onMount(() => {
		void load();
	});

	async function load(): Promise<void> {
		try {
			loading = true;
			error = null;
			const [m, d] = await Promise.all([client.getRoutingModels(), client.getClusterDefaults()]);
			models = m.models;
			defaults = d;
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load routing settings";
		} finally {
			loading = false;
		}
	}

	function toggle(logical: string): void {
		const next = new Set(expanded);
		if (next.has(logical)) next.delete(logical);
		else next.add(logical);
		expanded = next;
	}

	/** The model's three-state health: green if any route healthy, amber if only
	 * fallbacks are serving, grey if no route can serve. */
	function modelHealth(m: ModelRoutingInfo): "healthy" | "fallback" | "none" | "unknown" {
		const live = m.routes.filter((r) => !r.drained);
		if (live.length === 0) return "none";
		if (live.some((r) => r.health === "healthy")) return "healthy";
		if (live.some((r) => r.health === "backoff" || r.health === "half_open")) return "fallback";
		return "unknown";
	}

	/** host / provider label for a route row. */
	function routeLabel(r: RouteSupplyInfo): string {
		return `${r.host_name} / ${r.provider ?? "?"}`;
	}

	function healthText(r: RouteSupplyInfo): string {
		if (r.health === "backoff" && r.next_trial_at) {
			const secs = Math.max(0, Math.round((r.next_trial_at - Date.now()) / 1000));
			return `backoff · retry in ${secs}s`;
		}
		return r.health;
	}

	async function moveRoute(m: ModelRoutingInfo, index: number, dir: -1 | 1): Promise<void> {
		const order = m.routes.map((r) => r.route_id);
		const target = index + dir;
		if (target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		busy = m.logical_model;
		try {
			await client.setRouteOrder(m.logical_model, order);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to set route order";
		} finally {
			busy = null;
		}
	}

	async function toggleDrain(routeId: string, drained: boolean): Promise<void> {
		busy = routeId;
		try {
			if (drained) await client.undrainRoute(routeId);
			else await client.drainRoute(routeId);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to toggle drain";
		} finally {
			busy = null;
		}
	}

	async function removeStale(m: ModelRoutingInfo, routeId: string): Promise<void> {
		// Removing a stale route_order entry = rewrite route_order without it.
		const order = (m.route_order ?? []).filter((id) => id !== routeId);
		busy = routeId;
		try {
			await client.setRouteOrder(m.logical_model, order);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to remove stale route";
		} finally {
			busy = null;
		}
	}

	async function setFallback(m: ModelRoutingInfo, policy: FallbackPolicyInfo): Promise<void> {
		busy = m.logical_model;
		try {
			await client.setFallbackPolicy(m.logical_model, policy);
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to set fallback policy";
		} finally {
			busy = null;
		}
	}

	function onFallbackMode(m: ModelRoutingInfo, mode: string): void {
		if (mode === "auto") void setFallback(m, { mode: "auto" });
		else if (mode === "never") void setFallback(m, { mode: "never" });
		else if (mode === "custom") {
			const existing = m.fallback_policy.mode === "custom" ? m.fallback_policy.models : [];
			void setFallback(m, { mode: "custom", models: existing });
		}
	}
</script>

<Page>
	<SectionHeader
		title="Models"
		number="09"
		subtitle="Cluster routing preferences and per-host supply"
	/>

	{#if loading}
		<p class="muted">Loading routing settings...</p>
	{:else if error}
		<p class="error" role="alert">{error}</p>
	{:else}
		<section class="models">
			{#each models as m (m.logical_model)}
				<div class="model-row">
					<button type="button" class="model-head" onclick={() => toggle(m.logical_model)}>
						<ModelHealthDot state={modelHealth(m)} />
						<span class="logical">{m.display_name}</span>
						<span class="count">{m.routes.length} route{m.routes.length === 1 ? "" : "s"}</span>
						<span class="caret" aria-hidden="true">{expanded.has(m.logical_model) ? "▾" : "▸"}</span
						>
					</button>

					{#if expanded.has(m.logical_model)}
						<div class="routes">
							{#each m.routes as r, i (r.route_id)}
								<div class="route-row" class:drained={r.drained}>
									<span class="r-order">
										<button
											type="button"
											aria-label="Move up"
											disabled={i === 0 || busy !== null}
											onclick={() => moveRoute(m, i, -1)}>↑</button
										>
										<button
											type="button"
											aria-label="Move down"
											disabled={i === m.routes.length - 1 || busy !== null}
											onclick={() => moveRoute(m, i, 1)}>↓</button
										>
									</span>
									<span class="r-route">{routeLabel(r)}</span>
									<span class="r-health">{healthText(r)}</span>
									<label class="r-drain">
										<input
											type="checkbox"
											checked={r.drained}
											disabled={busy !== null}
											onchange={() => toggleDrain(r.route_id, r.drained)}
										/>
										Drain
									</label>
								</div>
							{/each}

							{#each m.stale_routes as s (s.route_id)}
								<div class="route-row stale">
									<span class="r-route">{s.host_name ?? "Unknown host"} / {s.provider ?? "?"}</span>
									<span class="r-stale-tag">stale</span>
									<Btn
										size="sm"
										variant="danger"
										disabled={busy !== null}
										onclick={() => removeStale(m, s.route_id)}>Remove</Btn
									>
								</div>
							{/each}

							<div class="fallback">
								<span class="fb-label">Fallback</span>
								<select
									aria-label="Fallback policy for {m.logical_model}"
									value={m.fallback_policy.mode}
									disabled={busy !== null}
									onchange={(e) => onFallbackMode(m, (e.currentTarget as HTMLSelectElement).value)}
								>
									<option value="auto">Automatic</option>
									<option value="custom">Custom list</option>
									<option value="never">Never substitute</option>
								</select>
								{#if m.fallback_policy.mode === "custom"}
									<span class="fb-custom">{m.fallback_policy.models.join(", ") || "(empty)"}</span>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
			{#if models.length === 0}
				<p class="muted">No logical models are advertised in the cluster yet.</p>
			{/if}
		</section>

		{#if defaults}
			<section class="cluster-defaults">
				<h3>Cluster defaults</h3>
				<div class="cd-row">
					<span class="cd-label">Default fallback list</span>
					<span class="cd-value">{defaults.default_fallback_models.join(", ") || "(none)"}</span>
				</div>
				<div class="cd-row">
					<span class="cd-label">Roles &amp; aliases</span>
					<span class="cd-value">
						{#if Object.keys(defaults.roles).length === 0}
							(none)
						{:else}
							{Object.entries(defaults.roles)
								.map(([name, model]) => `${name}: ${model}`)
								.join(", ")}
						{/if}
					</span>
				</div>
			</section>
		{/if}
	{/if}
</Page>

<style>
	.muted {
		color: var(--ink-3);
		font-size: var(--text-sm);
	}
	.error {
		color: var(--err);
		font-size: var(--text-sm);
	}
	.models {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 12px;
	}
	.model-row {
		border: 1px solid var(--rule-soft);
		border-radius: var(--r-sm);
	}
	.model-head {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--ink);
		text-align: left;
	}
	.logical {
		font-weight: 500;
	}
	.count {
		color: var(--ink-3);
		font-size: var(--text-xs);
	}
	.caret {
		margin-left: auto;
		color: var(--ink-4);
	}
	.routes {
		padding: 4px 12px 12px 34px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.route-row {
		display: flex;
		align-items: center;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--ink-2);
	}
	.route-row.drained .r-route {
		text-decoration: line-through;
		color: var(--ink-4);
	}
	.r-order button {
		border: 1px solid var(--rule-soft);
		background: transparent;
		cursor: pointer;
		padding: 0 4px;
		color: var(--ink-2);
	}
	.r-order button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.r-health {
		color: var(--ink-3);
	}
	.r-drain {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.route-row.stale .r-stale-tag {
		color: var(--warn);
	}
	.fallback {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--rule-faint);
	}
	.fb-label {
		color: var(--ink-3);
		font-size: var(--text-xs);
	}
	.fb-custom {
		color: var(--ink-3);
		font-size: var(--text-xs);
	}
	.cluster-defaults {
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid var(--rule-soft);
	}
	.cluster-defaults h3 {
		font-family: var(--font-header);
		font-size: var(--text-base);
		margin: 0 0 8px;
	}
	.cd-row {
		display: flex;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		padding: 3px 0;
	}
	.cd-label {
		color: var(--ink-3);
		min-width: 140px;
	}
	.cd-value {
		color: var(--ink-2);
	}
</style>
