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
	import { buildModelLabels, compareLabels } from "../lib/model-labels";

	// Settings › Models (2026-11-21-model-routing.md §9.3, 2026-11-21-model-catalog.md §9).
	// A searchable model list beside a detail pane. Routes render as
	// `provider:model on host`; "Enabled" is the inverse of an operator drain.
	// Automatic health states are read-only. Roles & aliases edit routing.model_roles.

	const RESERVED_ROLES = ["default", "heavy", "fast"] as const;

	let models = $state<ModelRoutingInfo[]>([]);
	let defaults = $state<ClusterDefaultsResponse | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let query = $state("");
	let selected = $state<string | null>(null);
	type RoleRow = { key: number; name: string; model: string };
	let roles = $state<RoleRow[]>([]);
	let roleKey = 0;
	// The roles as last loaded; a refresh never clobbers unsaved edits.
	let loadedRoles = "";
	const roleSnapshot = (rows: RoleRow[]) => JSON.stringify(rows.map((r) => [r.name, r.model]));
	let rolesError = $state<string | null>(null);
	let rolesSaved = $state(false);
	let now = $state(Date.now());

	const labels = $derived(buildModelLabels(models));
	const sorted = $derived(
		[...models].sort((a, b) => compareLabels(a.display_name, b.display_name)),
	);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter(
			(m) => m.display_name.toLowerCase().includes(q) || m.logical_model.toLowerCase().includes(q),
		);
	});
	const current = $derived(models.find((m) => m.logical_model === selected) ?? null);

	// Health comes from each serving host's own router; re-read it on the same
	// cadence as the countdown so a mounted page tracks recovery and backoff.
	const HEALTH_REFRESH_MS = 30_000;

	onMount(() => {
		void load();
		const timer = setInterval(() => {
			now = Date.now();
			void refreshHealth();
		}, HEALTH_REFRESH_MS);
		return () => clearInterval(timer);
	});

	/**
	 * Re-read routes (health included) without touching role edits or the error
	 * banner. Skipped while an edit is in flight; that edit reloads on its own.
	 */
	async function refreshHealth(): Promise<void> {
		if (busy !== null || loading) return;
		try {
			const m = await client.getRoutingModels();
			if (busy !== null) return;
			models = m.models;
		} catch {
			// Keep the last view; the next tick tries again.
		}
	}

	async function load(): Promise<void> {
		try {
			error = null;
			const [m, d] = await Promise.all([client.getRoutingModels(), client.getClusterDefaults()]);
			models = m.models;
			defaults = d;
			const dirty = loadedRoles !== "" && roleSnapshot(roles) !== loadedRoles;
			if (!dirty) {
				roles = rolesFrom(d.roles);
				loadedRoles = roleSnapshot(roles);
			}
			if (!selected || !models.some((x) => x.logical_model === selected)) {
				selected =
					[...models].sort((a, b) => compareLabels(a.display_name, b.display_name))[0]
						?.logical_model ?? null;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load models";
		} finally {
			loading = false;
		}
	}

	function rolesFrom(raw: Record<string, string>): RoleRow[] {
		const out: RoleRow[] = RESERVED_ROLES.map((name) => ({
			key: roleKey++,
			name,
			model: raw[name] ?? "",
		}));
		for (const [name, model] of Object.entries(raw).sort(([a], [b]) => compareLabels(a, b))) {
			if (!(RESERVED_ROLES as readonly string[]).includes(name))
				out.push({ key: roleKey++, name, model });
		}
		return out;
	}

	function modelHealth(m: ModelRoutingInfo): "healthy" | "fallback" | "none" | "unknown" {
		const live = m.routes.filter((r) => !r.drained);
		if (live.length === 0) return "none";
		if (live.some((r) => r.health === "healthy")) return "healthy";
		if (live.some((r) => r.health === "backoff" || r.health === "half_open")) return "fallback";
		return "unknown";
	}

	function hostCount(m: ModelRoutingInfo): number {
		return new Set(m.routes.map((r) => r.site_id)).size;
	}

	function displayFor(logical: string): string {
		return models.find((m) => m.logical_model === logical)?.display_name ?? logical;
	}

	/** Read-only automatic health text, e.g. "Backing off, retrying in 4m". */
	function healthText(r: RouteSupplyInfo, at: number): string {
		if (r.health === "backoff") {
			if (!r.next_trial_at) return "Backing off";
			const secs = Math.max(0, Math.round((r.next_trial_at - at) / 1000));
			const span = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
			return `Backing off, retrying in ${span}`;
		}
		if (r.health === "half_open") return "Trying again";
		if (r.health === "healthy") return "Healthy";
		return "Health not reported";
	}

	async function run(key: string, fn: () => Promise<unknown>, failure: string): Promise<void> {
		busy = key;
		try {
			await fn();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : failure;
		} finally {
			busy = null;
		}
	}

	function moveRoute(m: ModelRoutingInfo, index: number, dir: -1 | 1): void {
		const order = m.routes.map((r) => r.route_id);
		const target = index + dir;
		if (target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target] as string, order[index] as string];
		void run(
			m.logical_model,
			() => client.setRouteOrder(m.logical_model, order),
			"Failed to reorder",
		);
	}

	/** Enabled = not drained. Turning a route off drains it; on un-drains it. */
	function setEnabled(r: RouteSupplyInfo, enabled: boolean): void {
		void run(
			r.route_id,
			() => (enabled ? client.undrainRoute(r.route_id) : client.drainRoute(r.route_id)),
			"Failed to change route",
		);
	}

	function removeStale(m: ModelRoutingInfo, routeId: string): void {
		const order = (m.route_order ?? []).filter((id) => id !== routeId);
		void run(routeId, () => client.setRouteOrder(m.logical_model, order), "Failed to remove");
	}

	function setFallback(m: ModelRoutingInfo, policy: FallbackPolicyInfo): void {
		void run(
			m.logical_model,
			() => client.setFallbackPolicy(m.logical_model, policy),
			"Failed to update fallback policy",
		);
	}

	function onFallbackMode(m: ModelRoutingInfo, mode: string): void {
		if (mode === "auto") setFallback(m, { mode: "auto" });
		else if (mode === "never") setFallback(m, { mode: "never" });
		else {
			const existing = m.fallback_policy.mode === "custom" ? m.fallback_policy.models : [];
			setFallback(m, { mode: "custom", models: existing });
		}
	}

	function addFallbackModel(m: ModelRoutingInfo, logical: string): void {
		if (!logical || m.fallback_policy.mode !== "custom") return;
		if (m.fallback_policy.models.includes(logical)) return;
		setFallback(m, { mode: "custom", models: [...m.fallback_policy.models, logical] });
	}

	function removeFallbackModel(m: ModelRoutingInfo, logical: string): void {
		if (m.fallback_policy.mode !== "custom") return;
		setFallback(m, {
			mode: "custom",
			models: m.fallback_policy.models.filter((x) => x !== logical),
		});
	}

	function addAlias(): void {
		roles = [...roles, { key: roleKey++, name: "", model: "" }];
		rolesSaved = false;
	}

	function removeAlias(i: number): void {
		roles = roles.filter((_, idx) => idx !== i);
		rolesSaved = false;
	}

	async function saveRoles(): Promise<void> {
		rolesError = null;
		rolesSaved = false;
		const known = new Set(models.map((m) => m.logical_model));
		const out: Record<string, string> = {};
		for (const r of roles) {
			const name = r.name.trim();
			if (!name && !r.model) continue;
			if (!name || name.includes("@")) {
				rolesError = "Enter an alias name without '@'.";
				return;
			}
			if (out[name] !== undefined) {
				rolesError = `"${name}" is defined twice.`;
				return;
			}
			if (!r.model) continue;
			if (!known.has(r.model)) {
				rolesError = `"${name}" points to a model not available in this cluster.`;
				return;
			}
			out[name] = r.model;
		}
		busy = "roles";
		try {
			await client.setClusterDefaults({ roles: out });
			rolesSaved = true;
			loadedRoles = "";
			await load();
		} catch (e) {
			rolesError = e instanceof Error ? e.message : "Failed to save roles";
		} finally {
			busy = null;
		}
	}
</script>

<Page>
	<SectionHeader
		title="Models"
		number="09"
		subtitle="Route order, availability, and fallback models"
	/>

	{#if loading}
		<p class="muted">Loading models...</p>
	{:else if error && models.length === 0}
		<p class="error" role="alert">{error}</p>
	{:else}
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}
		<div class="layout">
			<aside class="list">
				<input
					class="search"
					type="search"
					placeholder="Search models"
					aria-label="Search models"
					bind:value={query}
				/>
				<ul class="model-list" aria-label="Models">
					{#each filtered as m (m.logical_model)}
						<li>
							<button
								type="button"
								class="model-item"
								aria-current={m.logical_model === selected ? "true" : undefined}
								class:active={m.logical_model === selected}
								onclick={() => (selected = m.logical_model)}
							>
								<ModelHealthDot state={modelHealth(m)} />
								<span class="name">{m.display_name}</span>
								<span class="count"
									>{m.routes.length} route{m.routes.length === 1 ? "" : "s"} · {hostCount(m)} host{hostCount(
										m,
									) === 1
										? ""
										: "s"}</span
								>
							</button>
						</li>
					{/each}
					{#if filtered.length === 0}
						<li class="muted empty">No models match.</li>
					{/if}
				</ul>
			</aside>

			<section class="detail" aria-label="Model detail">
				{#if current}
					{@const m = current}
					<header class="detail-head">
						<ModelHealthDot state={modelHealth(m)} />
						<h3>{m.display_name}</h3>
					</header>

					<div class="kicker">Route order</div>
					<ol class="routes">
						{#each m.routes as r, i (r.route_id)}
							<li class="route-row" class:drained={r.drained}>
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
								<span class="r-route mono">{labels.routeLabel(r.route_id)}</span>
								<span class="r-host">on {r.host_name}</span>
								<span class="r-health {r.health}">{healthText(r, now)}</span>
								<label class="toggle">
									<input
										type="checkbox"
										role="switch"
										checked={!r.drained}
										disabled={busy !== null}
										aria-label="Enabled: {labels.routeLabel(r.route_id)} on {r.host_name}"
										onchange={(e) => setEnabled(r, (e.currentTarget as HTMLInputElement).checked)}
									/>
									<span>Enabled</span>
								</label>
							</li>
						{/each}
						{#each m.stale_routes as s (s.route_id)}
							<li class="route-row stale">
								<span class="r-route">{s.host_name ?? "Unknown host"} / {s.provider ?? "?"}</span>
								<span class="r-stale-tag">Unavailable</span>
								<Btn
									size="sm"
									variant="danger"
									disabled={busy !== null}
									onclick={() => removeStale(m, s.route_id)}>Remove</Btn
								>
							</li>
						{/each}
					</ol>

					<div class="kicker">Fallback policy</div>
					<div class="fallback">
						<select
							aria-label="Fallback policy for {m.display_name}"
							value={m.fallback_policy.mode}
							disabled={busy !== null}
							onchange={(e) => onFallbackMode(m, (e.currentTarget as HTMLSelectElement).value)}
						>
							<option value="auto">Cluster default</option>
							<option value="custom">Custom list</option>
							<option value="never">Never fall back</option>
						</select>
						{#if m.fallback_policy.mode === "custom"}
							<ul class="chips">
								{#each m.fallback_policy.models as fb (fb)}
									<li class="chip">
										{displayFor(fb)}
										<button
											type="button"
											aria-label="Remove {displayFor(fb)}"
											onclick={() => removeFallbackModel(m, fb)}>×</button
										>
									</li>
								{/each}
							</ul>
							<select
								aria-label="Add fallback model"
								value=""
								onchange={(e) => addFallbackModel(m, (e.currentTarget as HTMLSelectElement).value)}
							>
								<option value="">Add a model…</option>
								{#each sorted.filter((x) => x.logical_model !== m.logical_model) as x (x.logical_model)}
									<option value={x.logical_model}>{x.display_name}</option>
								{/each}
							</select>
						{/if}
					</div>
				{:else}
					<p class="muted">No models available yet.</p>
				{/if}
			</section>
		</div>

		{#if defaults}
			<section class="roles" aria-label="Roles and aliases">
				<h3>Roles &amp; aliases</h3>
				<p class="muted">
					Reusable names for models. Agents and tasks can reference a role or alias instead of a
					specific model.
				</p>
				<div class="role-grid">
					{#each roles as r, i (r.key)}
						<div class="role-row">
							{#if (RESERVED_ROLES as readonly string[]).includes(r.name) && i < RESERVED_ROLES.length}
								<span class="role-name">{r.name}</span>
							{:else}
								<input
									class="role-name-input"
									aria-label="Alias name"
									placeholder="alias name"
									bind:value={r.name}
								/>
							{/if}
							<select aria-label="Model for {r.name || 'alias'}" bind:value={r.model}>
								<option value="">Not set</option>
								{#each sorted as x (x.logical_model)}
									<option value={x.logical_model}>{x.display_name}</option>
								{/each}
							</select>
							{#if i >= RESERVED_ROLES.length}
								<button
									type="button"
									class="link"
									aria-label="Remove alias"
									onclick={() => removeAlias(i)}>Remove</button
								>
							{/if}
						</div>
					{/each}
				</div>
				<div class="role-actions">
					<Btn size="sm" onclick={addAlias}>Add alias</Btn>
					<Btn size="sm" disabled={busy !== null} onclick={() => void saveRoles()}>Save</Btn>
					{#if rolesSaved}<span class="ok">Saved</span>{/if}
					{#if rolesError}<span class="error" role="alert">{rolesError}</span>{/if}
				</div>
				<div class="cd-row">
					<span class="cd-label">Cluster fallback list</span>
					<span class="cd-value"
						>{defaults.default_fallback_models.map(displayFor).join(", ") || "None"}</span
					>
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
	.ok {
		color: var(--ok);
		font-size: var(--text-sm);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		gap: 16px;
		margin-top: 12px;
		align-items: start;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--rule-soft);
		padding: 8px;
	}
	.search {
		padding: 6px 8px;
		border: 1px solid var(--rule-soft);
		background: transparent;
		color: var(--ink);
		font-size: var(--text-sm);
	}
	.model-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 60vh;
		overflow-y: auto;
	}
	.model-item {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 8px;
		align-items: center;
		width: 100%;
		padding: 6px 8px;
		background: transparent;
		border: none;
		border-left: 3px solid transparent;
		cursor: pointer;
		text-align: left;
		color: var(--ink-2);
		font-size: var(--text-sm);
	}
	.model-item.active,
	.model-item[aria-current="true"] {
		border-left-color: var(--ink);
		background: var(--rule-soft);
		color: var(--ink);
	}
	.model-item .count {
		grid-column: 2;
		font-size: 11px;
		color: var(--ink-4);
	}
	.detail {
		border: 1px solid var(--rule-soft);
		padding: 12px 16px;
	}
	.detail-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.detail-head h3 {
		margin: 0;
		font-family: var(--font-display);
	}
	.kicker {
		margin: 16px 0 6px;
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-4);
	}
	.routes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.route-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto auto;
		gap: 10px;
		align-items: center;
		padding: 6px 8px;
		border: 1px solid var(--rule-soft);
		font-size: var(--text-sm);
	}
	.route-row.drained {
		opacity: 0.6;
	}
	.route-row.stale {
		grid-template-columns: 1fr auto auto;
		border-style: dashed;
	}
	.r-order button {
		background: transparent;
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		color: var(--ink-2);
		padding: 0 5px;
	}
	.r-host {
		color: var(--ink-3);
	}
	.r-health {
		font-size: 11px;
		color: var(--ink-4);
	}
	.r-health.healthy {
		color: var(--ok);
	}
	.r-health.backoff,
	.r-health.half_open {
		color: var(--warn);
	}
	.r-stale-tag {
		font-size: 11px;
		color: var(--warn);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
	}
	.fallback {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.chip {
		border: 1px solid var(--rule-soft);
		padding: 2px 6px;
		font-size: 12px;
	}
	.chip button,
	.link {
		background: transparent;
		border: none;
		cursor: pointer;
		color: var(--ink-3);
	}
	.roles {
		margin-top: 24px;
		border-top: 1px solid var(--rule-soft);
		padding-top: 12px;
	}
	.role-grid {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 8px 0;
	}
	.role-row {
		display: grid;
		grid-template-columns: 160px minmax(0, 280px) auto;
		gap: 8px;
		align-items: center;
	}
	.role-name {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
	.role-actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.cd-row {
		display: flex;
		gap: 10px;
		margin-top: 12px;
		font-size: var(--text-sm);
	}
	.cd-label {
		color: var(--ink-3);
	}
	.r-route {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-item:focus-visible,
	button:focus-visible,
	select:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	@media (max-width: 760px) {
		.layout {
			grid-template-columns: 1fr;
		}
		.route-row {
			grid-template-columns: auto minmax(0, 1fr) auto;
		}
		.role-row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
