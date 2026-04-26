<script lang="ts">
import type { Advisory } from "@bound/shared";
import { onDestroy, onMount, untrack } from "svelte";
import Btn from "../components/Btn.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import StatusChip from "../components/StatusChip.svelte";
import TicketTab from "../components/TicketTab.svelte";
import { client } from "../lib/bound";
import { renderMarkdown } from "../lib/markdown";

let advisories: Advisory[] = $state([]);
let loading = $state(true);
let expandedId = $state<string | null>(null);
let resolvedExpanded = $state(false);
let actionInProgress = $state<string | null>(null);
let hostNameMap = $state<Map<string, string>>(new Map());
let sort = $state<"modified-desc" | "modified-asc" | "posted-desc">("modified-desc");

let pollInterval: ReturnType<typeof setInterval> | null = null;

type Severity = "warn" | "info";

// Map Advisory.type → severity token. The prototype had "err" too, but the
// production enum is just (info, warn), matching Service Advisory / Notice.
function severityOf(a: Advisory): Severity {
	const t = a.type as string;
	if (t === "warn" || t === "warning" || t === "alert") return "warn";
	return "info";
}

const SEV_LABEL: Record<Severity, { accent: string; label: string }> = {
	warn: { accent: "var(--warn)", label: "Service Advisory" },
	info: { accent: "var(--line-T)", label: "Notice" },
};

async function loadAdvisories(): Promise<void> {
	try {
		advisories = await client.listAdvisories();
	} catch (error) {
		console.error("Failed to load advisories:", error);
	}
	loading = false;
}

async function loadNetworkStatus(): Promise<void> {
	try {
		const data = await client.getNetwork();
		if (Array.isArray(data.hosts)) {
			const map = new Map<string, string>();
			for (const host of data.hosts) {
				const h = host as { site_id?: string; host_name?: string };
				if (h.site_id && h.host_name) map.set(h.site_id, h.host_name);
			}
			hostNameMap = map;
		}
	} catch (error) {
		console.error("Failed to load network status:", error);
	}
}

onMount(() => {
	loadAdvisories();
	loadNetworkStatus();
	pollInterval = setInterval(loadAdvisories, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

async function performAction(id: string, action: string): Promise<void> {
	actionInProgress = `${id}:${action}`;
	try {
		const actionMap: Record<string, (id: string) => Promise<unknown>> = {
			approve: (id) => client.approveAdvisory(id),
			dismiss: (id) => client.dismissAdvisory(id),
			defer: (id) => client.deferAdvisory(id),
			apply: (id) => client.applyAdvisory(id),
		};
		const fn = actionMap[action];
		if (fn) {
			await fn(id);
			await loadAdvisories();
		}
	} catch (error) {
		console.error(`Failed to ${action} advisory:`, error);
	}
	actionInProgress = null;
}

function toggleExpand(id: string): void {
	expandedId = expandedId === id ? null : id;
}

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function hostLabel(a: Advisory): string {
	if (!a.created_by) return "unknown";
	return hostNameMap.get(a.created_by) ?? a.created_by.slice(0, 10);
}

function sortFn(a: Advisory, b: Advisory): number {
	if (sort === "modified-desc") {
		return new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime();
	}
	if (sort === "modified-asc") {
		return new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime();
	}
	return new Date(b.proposed_at).getTime() - new Date(a.proposed_at).getTime();
}

const unresolved = $derived(
	advisories.filter((a) => ["proposed", "approved"].includes(a.status)).sort(sortFn),
);

const resolved = $derived(
	advisories.filter((a) => !["proposed", "approved"].includes(a.status)).sort(sortFn),
);

// Markdown-rendered advisory details, keyed by `${id}::${detail-length}`.
// Including the length (a cheap proxy for content identity) invalidates the
// cache when a detail is edited, so a replaced advisory doesn't keep showing
// the old HTML. Reads go through untrack() so the write-back in the .then()
// handler doesn't retrigger the effect and create the kind of infinite
// reactive loop that previously broke unrelated click handlers on the page.
let renderedDetail = $state<Record<string, string>>({});

function detailCacheKey(a: Advisory): string {
	return `${a.id}::${a.detail?.length ?? 0}`;
}

$effect(() => {
	for (const a of advisories) {
		if (!a.detail) continue;
		const key = detailCacheKey(a);
		const cached = untrack(() => renderedDetail[key]);
		if (cached) continue;
		renderMarkdown(a.detail)
			.then((html) => {
				renderedDetail = { ...renderedDetail, [key]: html };
			})
			.catch((err: unknown) => {
				console.error("[markdown] renderMarkdown failed:", err);
			});
	}
});
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={4} subtitle="Service Notices to Passengers" title="Advisories">
			{#snippet actions()}
				<TicketTab color="var(--accent)">
					{#snippet children()}{unresolved.length} open{/snippet}
				</TicketTab>
			{/snippet}
		</SectionHeader>

		{#if loading}
			<div class="state">
				<p>Loading advisories…</p>
			</div>
		{:else}
			<div class="sort-bar">
				<h2 class="section-title">Open · {unresolved.length}</h2>
				<div class="spacer"></div>
				<label class="sort-select">
					<span>Sort</span>
					<select bind:value={sort}>
						<option value="modified-desc">Modified · newest</option>
						<option value="modified-asc">Modified · oldest</option>
						<option value="posted-desc">Posted · newest</option>
					</select>
				</label>
			</div>

			<div class="adv-list">
				{#each unresolved as adv (adv.id)}
					{@const sev = SEV_LABEL[severityOf(adv)]}
					{@const expanded = expandedId === adv.id}
					{@const dimmed = adv.status === "dismissed" || adv.status === "applied"}
					<div class="adv-card" class:dimmed>
						<div class="sev-bar" style="background: {sev.accent}"></div>
						<button class="adv-head" onclick={() => toggleExpand(adv.id)}>
							<div class="sev-sigil" style="background: {sev.accent}">i</div>
							<div class="adv-title-block">
								<div class="kicker" style="color: {sev.accent}">{sev.label}</div>
								<h3 class="adv-title">{adv.title}</h3>
								<div class="adv-meta">
									<span>{relativeTime(adv.modified_at ?? adv.proposed_at)}</span>
									<span class="sep">·</span>
									<span>from {hostLabel(adv)}</span>
									<span class="sep">·</span>
									<StatusChip status={adv.status as never} />
								</div>
							</div>
							<span class="caret" class:open={expanded}>▼</span>
						</button>

						{#if expanded}
							<div class="adv-body">
								<div class="body-grid">
									<div>
										<div class="field-block">
											<div class="kicker">Detail</div>
											{#if renderedDetail[detailCacheKey(adv)]}
												<div class="field-body md-content">{@html renderedDetail[detailCacheKey(adv)]}</div>
											{:else}
												<p class="field-body">{adv.detail}</p>
											{/if}
										</div>
										{#if adv.action}
											<div class="field-block">
												<div class="kicker accent-label">Recommended Action</div>
												<p class="field-body accent-body">{adv.action}</p>
											</div>
										{/if}
										{#if adv.impact}
											<div class="field-block">
												<div class="kicker">Impact</div>
												<p class="field-body">{adv.impact}</p>
											</div>
										{/if}
									</div>
									<div>
										{#if adv.evidence}
											<div class="kicker">Evidence</div>
											<pre class="evidence">{adv.evidence}</pre>
										{/if}
									</div>
								</div>

								{#if ["proposed", "deferred", "approved"].includes(adv.status)}
									<div class="action-bar">
										{#if adv.status === "approved"}
											<Btn
												variant="accent"
												size="sm"
												disabled={actionInProgress === `${adv.id}:apply`}
												onclick={() => performAction(adv.id, "apply")}
											>
												{#snippet children()}Apply{/snippet}
											</Btn>
										{:else}
											<Btn
												variant="primary"
												size="sm"
												disabled={actionInProgress === `${adv.id}:approve`}
												onclick={() => performAction(adv.id, "approve")}
											>
												{#snippet children()}Approve{/snippet}
											</Btn>
											<Btn
												variant="default"
												size="sm"
												disabled={actionInProgress === `${adv.id}:defer`}
												onclick={() => performAction(adv.id, "defer")}
											>
												{#snippet children()}Defer{/snippet}
											</Btn>
											<Btn
												variant="ghost"
												size="sm"
												disabled={actionInProgress === `${adv.id}:dismiss`}
												onclick={() => performAction(adv.id, "dismiss")}
											>
												{#snippet children()}Dismiss{/snippet}
											</Btn>
										{/if}
										<div class="spacer"></div>
										<span class="adv-id-stamp mono">ID · {adv.id.slice(0, 12)}</span>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}

				{#if unresolved.length === 0}
					<div class="empty">No open advisories. Systems nominal.</div>
				{/if}
			</div>

			{#if resolved.length > 0}
				<div class="resolved-section">
					<button
						class="resolved-toggle"
						onclick={() => (resolvedExpanded = !resolvedExpanded)}
					>
						<span>Resolved · {resolved.length}</span>
						<div class="spacer"></div>
						<span class="resolved-caret mono">
							{resolvedExpanded ? "Hide" : "Show"} ▼
						</span>
					</button>
					{#if resolvedExpanded}
						<div class="adv-list resolved-list">
							{#each resolved as adv (adv.id)}
								{@const sev = SEV_LABEL[severityOf(adv)]}
								{@const expanded = expandedId === adv.id}
								<div class="adv-card dimmed">
									<div class="sev-bar" style="background: {sev.accent}"></div>
									<button class="adv-head" onclick={() => toggleExpand(adv.id)}>
										<div class="sev-sigil" style="background: {sev.accent}">i</div>
										<div class="adv-title-block">
											<div class="kicker" style="color: {sev.accent}">{sev.label}</div>
											<h3 class="adv-title">{adv.title}</h3>
											<div class="adv-meta">
												<span>{relativeTime(adv.modified_at ?? adv.proposed_at)}</span>
												<span class="sep">·</span>
												<span>from {hostLabel(adv)}</span>
												<span class="sep">·</span>
												<StatusChip status={adv.status as never} />
											</div>
										</div>
										<span class="caret" class:open={expanded}>▼</span>
									</button>
									{#if expanded && (adv.detail || adv.evidence)}
										<div class="adv-body">
											<div class="body-grid">
												<div>
													<div class="field-block">
														<div class="kicker">Detail</div>
														{#if renderedDetail[detailCacheKey(adv)]}
															<div class="field-body md-content">{@html renderedDetail[detailCacheKey(adv)]}</div>
														{:else}
															<p class="field-body">{adv.detail}</p>
														{/if}
													</div>
												</div>
												<div>
													{#if adv.evidence}
														<div class="kicker">Evidence</div>
														<pre class="evidence">{adv.evidence}</pre>
													{/if}
												</div>
											</div>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	{/snippet}
</Page>

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.sort-bar {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin: 2px 0 12px 0;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.section-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.005em;
		color: var(--ink);
	}

	.spacer {
		flex: 1;
	}

	.sort-select {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.sort-select span {
		font-weight: 500;
	}

	.sort-select select {
		padding: 4px 8px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		color: var(--ink);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 0;
	}

	.adv-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.adv-card {
		position: relative;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
	}

	.adv-card.dimmed {
		opacity: 0.66;
	}

	.sev-bar {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 6px;
	}

	.adv-head {
		display: grid;
		grid-template-columns: 40px 1fr auto;
		align-items: center;
		width: 100%;
		padding: 16px 18px 16px 22px;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		gap: 14px;
		color: inherit;
		font: inherit;
	}

	.sev-sigil {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 17px;
		font-weight: 600;
	}

	.adv-title-block {
		min-width: 0;
		padding-right: 20px;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 3px;
	}

	.adv-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 15.5px;
		font-weight: 600;
		letter-spacing: -0.005em;
		color: var(--ink);
	}

	.adv-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 6px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.sep {
		color: var(--ink-4);
	}

	.caret {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-3);
		transition: transform 0.15s ease;
	}

	.caret.open {
		transform: rotate(180deg);
	}

	.adv-body {
		padding: 0 22px 20px 22px;
		border-top: 1px solid var(--rule-faint);
	}

	.body-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 28px;
		padding-top: 16px;
	}

	.field-block {
		margin-bottom: 16px;
	}

	.field-body {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--ink);
	}

	.accent-label {
		color: var(--accent) !important;
	}

	.accent-body {
		padding-left: 12px;
		border-left: 3px solid var(--accent);
		font-family: var(--font-serif);
		font-size: 14px;
	}

	.evidence {
		margin: 8px 0 0;
		padding: 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-2);
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 180px;
		overflow-y: auto;
	}

	.action-bar {
		margin-top: 18px;
		padding-top: 14px;
		border-top: 1px dashed var(--rule-soft);
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.adv-id-stamp {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--ink-4);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.empty {
		padding: 32px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.resolved-section {
		margin-top: 32px;
	}

	.resolved-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 0;
		background: transparent;
		border: none;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 600;
		color: var(--ink-2);
		width: 100%;
		text-align: left;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.resolved-caret {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-3);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.resolved-list {
		margin-top: 14px;
	}
</style>
