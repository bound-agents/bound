<script lang="ts">
import type { Advisory } from "@bound/shared";
import { ChevronDown } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { LineBadge, MetroCard, SectionHeader, StatusChip } from "../components/shared";
import { type DedupedAdvisory, deduplicateAdvisories } from "../lib/advisory-utils";

let advisories: Advisory[] = $state([]);
let loading = $state(true);
let expandedId = $state<string | null>(null);
let resolvedExpanded = $state(false);
let actionInProgress = $state<string | null>(null);
let hostNameMap = $state<Map<string, string>>(new Map());

let pollInterval: ReturnType<typeof setInterval> | null = null;

const deduped = $derived(deduplicateAdvisories(advisories));
const unresolved = $derived(
	deduped.filter((a) => ["proposed", "approved"].includes(a.representative.status)),
);
const resolved = $derived(
	deduped.filter((a) => !["proposed", "approved"].includes(a.representative.status)),
);

async function loadAdvisories(): Promise<void> {
	try {
		const response = await fetch("/api/advisories");
		if (response.ok) {
			advisories = await response.json();
		}
	} catch (error) {
		console.error("Failed to load advisories:", error);
	}
	loading = false;
}

async function loadNetworkStatus(): Promise<void> {
	try {
		const response = await fetch("/api/status/network");
		if (response.ok) {
			const data = await response.json();
			if (Array.isArray(data.hosts)) {
				const map = new Map<string, string>();
				for (const host of data.hosts) {
					if (host.site_id && host.host_name) {
						map.set(host.site_id, host.host_name);
					}
				}
				hostNameMap = map;
			}
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
		const response = await fetch(`/api/advisories/${id}/${action}`, {
			method: "POST",
		});
		if (response.ok) {
			await loadAdvisories();
		} else {
			console.error(`Failed to ${action} advisory:`, await response.text());
		}
	} catch (error) {
		console.error(`Failed to ${action} advisory:`, error);
	}
	actionInProgress = null;
}

function toggleExpand(id: string): void {
	expandedId = expandedId === id ? null : id;
}

function isActionInProgress(id: string, action: string): boolean {
	return actionInProgress === `${id}:${action}`;
}

function canApprove(status: string): boolean {
	return status === "proposed" || status === "deferred";
}

function canDismiss(status: string): boolean {
	return status === "proposed" || status === "deferred";
}

function canDefer(status: string): boolean {
	return status === "proposed";
}

function canApply(status: string): boolean {
	return status === "approved";
}

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 0 || mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function getLineIndex(siteId: string | null): number {
	if (!siteId) return 0;
	const hash = siteId.split("").reduce((h, c) => h + c.charCodeAt(0), 0);
	return hash % 10;
}

function getSourceBadgeLabel(advisory: Advisory): string {
	const hostName = advisory.created_by ? hostNameMap.get(advisory.created_by) : null;
	return hostName || "unknown";
}

function getStatusColor(status: string): string {
	switch (status) {
		case "proposed":
			return "var(--alert-warning)";
		case "approved":
			return "var(--status-active)";
		case "dismissed":
			return "var(--text-muted)";
		case "deferred":
			return "var(--line-3)";
		case "applied":
			return "var(--line-6)";
		default:
			return "var(--text-muted)";
	}
}

function getSeverityBandClass(status: string): string {
	switch (status) {
		case "proposed":
			return "severity-band-proposed";
		case "approved":
			return "severity-band-approved";
		case "dismissed":
			return "severity-band-dismissed";
		case "deferred":
			return "severity-band-deferred";
		case "applied":
			return "severity-band-applied";
		default:
			return "";
	}
}
</script>

<div class="advisory-view">
	<SectionHeader title="Advisories" subtitle="Service Notices" />

	{#if loading}
		<div class="loading-state">
			<div class="loading-bar"></div>
			<p>Loading advisories...</p>
		</div>
	{:else if advisories.length === 0}
		<div class="empty-state">
			<svg width="80" height="48" viewBox="0 0 80 48">
				<circle cx="40" cy="24" r="16" fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.3" />
				<path d="M40 16V26" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" opacity="0.3" />
				<circle cx="40" cy="30" r="1.5" fill="var(--text-muted)" opacity="0.3" />
			</svg>
			<p>No advisories found.</p>
		</div>
	{:else}
		<div class="advisory-sections">
			{#if unresolved.length > 0}
				<div class="section">
					<h2 class="section-title">Unresolved</h2>
					<div class="advisory-list">
						{#each unresolved as dedup (dedup.representative.id)}
							<div class={getSeverityBandClass(dedup.representative.status)}>
								<MetroCard>
									<button
										class="card-main"
										onclick={() => toggleExpand(dedup.representative.id)}
									>
										<div class="card-left">
											<LineBadge
												lineIndex={getLineIndex(dedup.representative.created_by)}
												size="standard"
											/>
											<div class="card-info">
												<div class="card-title-row">
													<span class="card-title">{dedup.representative.title}</span>
													{#if dedup.count > 1}
														<span class="count-badge">×{dedup.count}</span>
													{/if}
												</div>
												<div class="card-meta">
													<StatusChip
														status={dedup.representative.status}
														label={dedup.representative.status.toUpperCase()}
													/>
													<span class="card-time">{relativeTime(dedup.representative.proposed_at)}</span>
													<span class="card-source">
														from {getSourceBadgeLabel(dedup.representative)}
													</span>
												</div>
											</div>
										</div>
										<div class="card-right">
											<span class="expand-icon" class:rotated={expandedId === dedup.representative.id}>
												<ChevronDown size={12} />
											</span>
										</div>
									</button>

									{#if expandedId === dedup.representative.id}
										<div class="card-expanded-content">
											<div class="detail-section">
												<h4>Detail</h4>
												<p class="detail-text">{dedup.representative.detail}</p>
											</div>

											{#if dedup.representative.action}
												<div class="detail-section">
													<h4>Recommended Action</h4>
													<p class="detail-text">{dedup.representative.action}</p>
												</div>
											{/if}

											{#if dedup.representative.impact}
												<div class="detail-section">
													<h4>Impact</h4>
													<p class="detail-text">{dedup.representative.impact}</p>
												</div>
											{/if}

											{#if dedup.representative.evidence}
												<div class="detail-section">
													<h4>Evidence</h4>
													<pre class="evidence-block">{dedup.representative.evidence}</pre>
												</div>
											{/if}

											{#if dedup.representative.defer_until}
												<div class="detail-section">
													<h4>Deferred Until</h4>
													<p class="detail-text">
														{new Date(dedup.representative.defer_until).toLocaleString()}
													</p>
												</div>
											{/if}

											{#if dedup.count > 1}
												<div class="detail-section">
													<h4>Sources ({dedup.count})</h4>
													<div class="sources-list">
														{#each dedup.sources as source}
															<div class="source-item">
																<span class="source-time">
																	{relativeTime(source.proposed_at)}
																</span>
																{#if source.created_by && hostNameMap.has(source.created_by)}
																	<span class="source-host">
																		{hostNameMap.get(source.created_by)}
																	</span>
																{/if}
															</div>
														{/each}
													</div>
												</div>
											{/if}

											<div class="action-bar">
												{#if canApprove(dedup.representative.status)}
													<button
														class="action-btn"
														onclick={() => performAction(dedup.representative.id, "approve")}
														disabled={actionInProgress !== null}
													>
														{isActionInProgress(dedup.representative.id, "approve") ? "..." : "Approve"}
													</button>
												{/if}
												{#if canDismiss(dedup.representative.status)}
													<button
														class="action-btn"
														onclick={() => performAction(dedup.representative.id, "dismiss")}
														disabled={actionInProgress !== null}
													>
														{isActionInProgress(dedup.representative.id, "dismiss") ? "..." : "Dismiss"}
													</button>
												{/if}
												{#if canDefer(dedup.representative.status)}
													<button
														class="action-btn"
														onclick={() => performAction(dedup.representative.id, "defer")}
														disabled={actionInProgress !== null}
													>
														{isActionInProgress(dedup.representative.id, "defer") ? "..." : "Defer"}
													</button>
												{/if}
												{#if canApply(dedup.representative.status)}
													<button
														class="action-btn"
														onclick={() => performAction(dedup.representative.id, "apply")}
														disabled={actionInProgress !== null}
													>
														{isActionInProgress(dedup.representative.id, "apply") ? "..." : "Apply"}
													</button>
												{/if}
											</div>

											<div class="card-footer-meta">
												<span class="footer-id" title={dedup.representative.id}>
													ID: {dedup.representative.id.substring(0, 8)}
												</span>
												<span class="footer-modified">
													Modified: {relativeTime(dedup.representative.modified_at)}
												</span>
											</div>
										</div>
									{/if}
								</MetroCard>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if resolved.length > 0}
				<div class="section resolved-section">
					<button class="section-toggle" onclick={() => (resolvedExpanded = !resolvedExpanded)}>
						<h2 class="section-title">
							Resolved ({resolved.length})
						</h2>
						<span class="toggle-icon" class:rotated={resolvedExpanded}>
							<ChevronDown size={16} />
						</span>
					</button>

					{#if resolvedExpanded}
						<div class="advisory-list">
							{#each resolved as dedup (dedup.representative.id)}
								<div class={getSeverityBandClass(dedup.representative.status)}>
									<MetroCard>
										<button
											class="card-main"
											onclick={() => toggleExpand(dedup.representative.id)}
										>
											<div class="card-left">
												<LineBadge
													lineIndex={getLineIndex(dedup.representative.created_by)}
													size="standard"
												/>
												<div class="card-info">
													<div class="card-title-row">
														<span class="card-title">{dedup.representative.title}</span>
														{#if dedup.count > 1}
															<span class="count-badge">×{dedup.count}</span>
														{/if}
													</div>
													<div class="card-meta">
														<StatusChip
															status={dedup.representative.status}
															label={dedup.representative.status.toUpperCase()}
														/>
														<span class="card-time">{relativeTime(dedup.representative.proposed_at)}</span>
														<span class="card-source">
															from {getSourceBadgeLabel(dedup.representative)}
														</span>
													</div>
												</div>
											</div>
											<div class="card-right">
												<span class="expand-icon" class:rotated={expandedId === dedup.representative.id}>
													<ChevronDown size={12} />
												</span>
											</div>
										</button>

										{#if expandedId === dedup.representative.id}
											<div class="card-expanded-content">
												<div class="detail-section">
													<h4>Detail</h4>
													<p class="detail-text">{dedup.representative.detail}</p>
												</div>

												{#if dedup.representative.action}
													<div class="detail-section">
														<h4>Recommended Action</h4>
														<p class="detail-text">{dedup.representative.action}</p>
													</div>
												{/if}

												{#if dedup.representative.impact}
													<div class="detail-section">
														<h4>Impact</h4>
														<p class="detail-text">{dedup.representative.impact}</p>
													</div>
												{/if}

												{#if dedup.representative.evidence}
													<div class="detail-section">
														<h4>Evidence</h4>
														<pre class="evidence-block">{dedup.representative.evidence}</pre>
													</div>
												{/if}

												{#if dedup.representative.resolved_at}
													<div class="detail-section">
														<h4>Resolved At</h4>
														<p class="detail-text">
															{new Date(dedup.representative.resolved_at).toLocaleString()}
														</p>
													</div>
												{/if}

												{#if dedup.count > 1}
													<div class="detail-section">
														<h4>Sources ({dedup.count})</h4>
														<div class="sources-list">
															{#each dedup.sources as source}
																<div class="source-item">
																	<span class="source-time">
																		{relativeTime(source.proposed_at)}
																	</span>
																	{#if source.created_by && hostNameMap.has(source.created_by)}
																		<span class="source-host">
																			{hostNameMap.get(source.created_by)}
																		</span>
																	{/if}
																</div>
															{/each}
														</div>
													</div>
												{/if}
											</div>
										{/if}
									</MetroCard>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.advisory-view {
		padding: 32px 40px;
		max-width: 860px;
		margin: 0 auto;
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 48px 0;
	}

	.loading-bar {
		width: 120px;
		height: 3px;
		background: var(--bg-surface);
		border-radius: 2px;
		position: relative;
		overflow: hidden;
	}

	.loading-bar::after {
		content: "";
		position: absolute;
		top: 0;
		left: -40%;
		width: 40%;
		height: 100%;
		background: var(--line-5);
		border-radius: 2px;
		animation: loadingSlide 1.2s ease-in-out infinite;
	}

	@keyframes loadingSlide {
		0% {
			left: -40%;
		}
		100% {
			left: 100%;
		}
	}

	.loading-state p,
	.empty-state p {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 48px 0;
		text-align: center;
	}

	.advisory-sections {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.section-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 700;
		color: var(--text-primary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 0 4px;
	}

	.resolved-section {
		gap: 8px;
	}

	.section-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		color: inherit;
		font-family: inherit;
		text-align: left;
	}

	.section-toggle:hover .section-title {
		color: var(--line-5);
	}

	.toggle-icon {
		flex-shrink: 0;
		color: var(--text-muted);
		transition: transform 0.2s ease;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.toggle-icon.rotated {
		transform: rotate(180deg);
	}

	.advisory-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.severity-band-proposed,
	.severity-band-approved,
	.severity-band-dismissed,
	.severity-band-deferred,
	.severity-band-applied {
		border-radius: 8px;
		overflow: hidden;
	}

	.severity-band-proposed {
		--band-color: var(--alert-warning);
	}

	.severity-band-approved {
		--band-color: var(--status-active);
	}

	.severity-band-dismissed {
		opacity: 0.6;
	}

	.severity-band-deferred {
		opacity: 0.6;
	}

	.severity-band-applied {
		--band-color: var(--line-6);
	}

	.severity-band-proposed :global(.metro-card),
	.severity-band-approved :global(.metro-card),
	.severity-band-applied :global(.metro-card) {
		border-top: 4px solid var(--band-color);
	}

	.card-main {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 12px;
		background: transparent;
		border: none;
		cursor: pointer;
		color: inherit;
		font-family: inherit;
		text-align: left;
	}

	.card-main:focus-visible {
		outline: 2px solid var(--line-5);
		outline-offset: -2px;
		border-radius: 8px;
	}

	.card-left {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
		min-width: 0;
	}

	.card-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.card-title-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.card-title {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.count-badge {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		color: var(--text-muted);
		background: rgba(107, 107, 128, 0.1);
		padding: 2px 6px;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.card-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
	}

	.card-time {
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.card-source {
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.card-right {
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.expand-icon {
		transition: transform 0.2s ease;
	}

	.expand-icon.rotated {
		transform: rotate(180deg);
	}

	.card-expanded-content {
		padding: 12px;
		border-top: 1px solid var(--bg-surface);
	}

	.detail-section {
		margin-top: 12px;
	}

	.detail-section h4 {
		margin: 0 0 6px 0;
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.detail-text {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-primary);
		line-height: 1.6;
	}

	.evidence-block {
		margin: 0;
		padding: 12px;
		background: rgba(10, 10, 20, 0.6);
		border: 1px solid var(--bg-surface);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-secondary);
		white-space: pre-wrap;
		word-break: break-all;
		line-height: 1.5;
		overflow-x: auto;
	}

	.sources-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.source-item {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.source-time {
		flex-shrink: 0;
	}

	.source-host {
		color: var(--text-secondary);
	}

	.action-bar {
		display: flex;
		gap: 6px;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--bg-surface);
		flex-wrap: wrap;
	}

	.action-btn {
		background: transparent;
		border: 1px solid var(--text-muted);
		border-radius: 4px;
		padding: 4px 12px;
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-primary);
		cursor: pointer;
		transition: all 0.2s ease;
		font-family: var(--font-display);
	}

	.action-btn:hover:not(:disabled) {
		border-color: var(--line-5);
		color: var(--line-5);
	}

	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.card-footer-meta {
		display: flex;
		justify-content: space-between;
		margin-top: 8px;
		padding-top: 8px;
		font-size: 11px;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.footer-id,
	.footer-modified {
		opacity: 0.6;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-bar::after {
			animation: none;
		}

		.expand-icon,
		.toggle-icon {
			transition: none;
		}
	}
</style>
