<script lang="ts">
import { ChevronDown } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";

interface Advisory {
	id: string;
	type: string;
	status: string;
	title: string;
	detail: string;
	action: string | null;
	impact: string | null;
	evidence: string | null;
	proposed_at: string;
	defer_until: string | null;
	resolved_at: string | null;
	created_by: string | null;
	modified_at: string;
}

let advisories: Advisory[] = $state([]);
let loading = $state(true);
let expandedId = $state<string | null>(null);
let filterStatus = $state("");
let actionInProgress = $state<string | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function loadAdvisories(): Promise<void> {
	try {
		const url = filterStatus ? `/api/advisories?status=${filterStatus}` : "/api/advisories";
		const response = await fetch(url);
		if (response.ok) {
			advisories = await response.json();
		}
	} catch (error) {
		console.error("Failed to load advisories:", error);
	}
	loading = false;
}

onMount(() => {
	loadAdvisories();
	pollInterval = setInterval(loadAdvisories, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

function handleFilterChange(): void {
	loading = true;
	loadAdvisories();
}

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

function statusClass(status: string): string {
	switch (status) {
		case "proposed":
			return "badge-proposed";
		case "approved":
			return "badge-approved";
		case "dismissed":
			return "badge-dismissed";
		case "deferred":
			return "badge-deferred";
		case "applied":
			return "badge-applied";
		default:
			return "badge-unknown";
	}
}

function typeIcon(type: string): string {
	switch (type) {
		case "cost":
			return "$";
		case "frequency":
			return "~";
		case "memory":
			return "M";
		case "model":
			return "A";
		case "general":
			return "*";
		default:
			return "?";
	}
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

const proposedCount = $derived(advisories.filter((a) => a.status === "proposed").length);
</script>

<div class="advisory-view">
	<div class="advisory-header">
		<h1>Advisories</h1>
		<span class="subtitle">Service Notices</span>
		{#if proposedCount > 0}
			<span class="pending-count">{proposedCount} pending</span>
		{/if}
		<div class="filter-area">
			<select bind:value={filterStatus} onchange={handleFilterChange} class="filter-select" aria-label="Filter by status">
				<option value="">All Statuses</option>
				<option value="proposed">Proposed</option>
				<option value="approved">Approved</option>
				<option value="dismissed">Dismissed</option>
				<option value="deferred">Deferred</option>
				<option value="applied">Applied</option>
			</select>
		</div>
	</div>

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
		<div class="advisory-list">
			{#each advisories as advisory}
				<div class="advisory-card" class:card-proposed={advisory.status === "proposed"} class:card-expanded={expandedId === advisory.id}>
					<button
						class="card-main"
						onclick={() => toggleExpand(advisory.id)}
					>
						<div class="card-left">
							<div class="type-badge" title={advisory.type}>
								<span class="type-icon">{typeIcon(advisory.type)}</span>
							</div>
							<div class="card-info">
								<span class="card-title">{advisory.title}</span>
								<span class="card-meta">
									<span class="status-badge {statusClass(advisory.status)}">{advisory.status}</span>
									<span class="card-time">{relativeTime(advisory.proposed_at)}</span>
									{#if advisory.created_by}
										<span class="card-author">by {advisory.created_by}</span>
									{/if}
								</span>
							</div>
						</div>
						<div class="card-right">
							<span class="expand-icon" class:rotated={expandedId === advisory.id}>
								<ChevronDown size={12} />
							</span>
						</div>
					</button>

					{#if expandedId === advisory.id}
						<div class="card-expanded-content">
							<div class="detail-section">
								<h4>Detail</h4>
								<p class="detail-text">{advisory.detail}</p>
							</div>

							{#if advisory.action}
								<div class="detail-section">
									<h4>Recommended Action</h4>
									<p class="detail-text">{advisory.action}</p>
								</div>
							{/if}

							{#if advisory.impact}
								<div class="detail-section">
									<h4>Impact</h4>
									<p class="detail-text">{advisory.impact}</p>
								</div>
							{/if}

							{#if advisory.evidence}
								<div class="detail-section">
									<h4>Evidence</h4>
									<pre class="evidence-block">{advisory.evidence}</pre>
								</div>
							{/if}

							{#if advisory.defer_until}
								<div class="detail-section">
									<h4>Deferred Until</h4>
									<p class="detail-text">{new Date(advisory.defer_until).toLocaleString()}</p>
								</div>
							{/if}

							{#if advisory.resolved_at}
								<div class="detail-section">
									<h4>Resolved At</h4>
									<p class="detail-text">{new Date(advisory.resolved_at).toLocaleString()}</p>
								</div>
							{/if}

							<div class="action-bar">
								{#if canApprove(advisory.status)}
									<button
										class="action-btn approve-btn"
										onclick={() => performAction(advisory.id, "approve")}
										disabled={actionInProgress !== null}
									>
										{isActionInProgress(advisory.id, "approve") ? "..." : "Approve"}
									</button>
								{/if}
								{#if canDismiss(advisory.status)}
									<button
										class="action-btn dismiss-btn"
										onclick={() => performAction(advisory.id, "dismiss")}
										disabled={actionInProgress !== null}
									>
										{isActionInProgress(advisory.id, "dismiss") ? "..." : "Dismiss"}
									</button>
								{/if}
								{#if canDefer(advisory.status)}
									<button
										class="action-btn defer-btn"
										onclick={() => performAction(advisory.id, "defer")}
										disabled={actionInProgress !== null}
									>
										{isActionInProgress(advisory.id, "defer") ? "..." : "Defer"}
									</button>
								{/if}
								{#if canApply(advisory.status)}
									<button
										class="action-btn apply-btn"
										onclick={() => performAction(advisory.id, "apply")}
										disabled={actionInProgress !== null}
									>
										{isActionInProgress(advisory.id, "apply") ? "..." : "Apply"}
									</button>
								{/if}
							</div>

							<div class="card-footer-meta">
								<span class="footer-id" title={advisory.id}>ID: {advisory.id.substring(0, 8)}</span>
								<span class="footer-modified">Modified: {relativeTime(advisory.modified_at)}</span>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.advisory-view {
		padding: 32px 40px;
		max-width: 860px;
		margin: 0 auto;
	}

	.advisory-header {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 32px;
		flex-wrap: wrap;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: 700;
	}

	.subtitle {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.pending-count {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--alert-warning);
		background: rgba(255, 145, 0, 0.1);
		border: 1px solid rgba(255, 145, 0, 0.3);
		padding: 2px 10px;
		border-radius: 10px;
	}

	.filter-area {
		margin-left: auto;
	}

	.filter-select {
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--bg-surface);
		background: var(--bg-primary);
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 12px;
		cursor: pointer;
		transition: border-color 0.2s ease;
		appearance: auto;
	}

	.filter-select:hover {
		border-color: var(--line-5);
	}

	.filter-select:focus {
		outline: none;
		border-color: var(--line-5);
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
		0% { left: -40%; }
		100% { left: 100%; }
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

	/* Advisory list */
	.advisory-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.advisory-card {
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		overflow: hidden;
		transition: all 0.2s ease;
	}

	.advisory-card:hover {
		border-color: rgba(193, 164, 112, 0.4);
	}

	.advisory-card.card-proposed {
		border-left: 3px solid var(--alert-warning);
	}

	.advisory-card.card-expanded {
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
	}

	.card-main {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 16px 20px;
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
		gap: 16px;
		flex: 1;
		min-width: 0;
	}

	.type-badge {
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border-radius: 6px;
		background: rgba(193, 164, 112, 0.12);
		border: 1px solid rgba(193, 164, 112, 0.25);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.type-icon {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 700;
		color: var(--line-5);
	}

	.card-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
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

	.card-meta {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.card-time {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
	}

	.card-author {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
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

	/* Status badges */
	.status-badge {
		font-family: var(--font-display);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 2px 8px;
		border-radius: 3px;
	}

	.badge-proposed {
		color: var(--alert-warning);
		background: rgba(255, 145, 0, 0.1);
	}

	.badge-approved {
		color: var(--status-active);
		background: rgba(105, 240, 174, 0.1);
	}

	.badge-dismissed {
		color: var(--text-muted);
		background: rgba(107, 107, 128, 0.1);
	}

	.badge-deferred {
		color: var(--line-3);
		background: rgba(0, 155, 191, 0.1);
	}

	.badge-applied {
		color: var(--line-6);
		background: rgba(143, 118, 214, 0.1);
	}

	.badge-unknown {
		color: var(--text-muted);
		background: rgba(107, 107, 128, 0.08);
	}

	/* Expanded content */
	.card-expanded-content {
		padding: 0 20px 20px;
		border-top: 1px solid rgba(15, 52, 96, 0.4);
	}

	.detail-section {
		margin-top: 16px;
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
		border: 1px solid rgba(15, 52, 96, 0.4);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-secondary);
		white-space: pre-wrap;
		word-break: break-all;
		line-height: 1.5;
		overflow-x: auto;
	}

	/* Action bar */
	.action-bar {
		display: flex;
		gap: 8px;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid rgba(15, 52, 96, 0.3);
	}

	.action-btn {
		padding: 8px 16px;
		border-radius: 6px;
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition: all 0.2s ease;
		border: 1px solid transparent;
	}

	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.approve-btn {
		background: rgba(105, 240, 174, 0.1);
		border-color: rgba(105, 240, 174, 0.3);
		color: var(--status-active);
	}

	.approve-btn:hover:not(:disabled) {
		background: rgba(105, 240, 174, 0.2);
	}

	.dismiss-btn {
		background: rgba(107, 107, 128, 0.1);
		border-color: rgba(107, 107, 128, 0.3);
		color: var(--text-muted);
	}

	.dismiss-btn:hover:not(:disabled) {
		background: rgba(107, 107, 128, 0.2);
	}

	.defer-btn {
		background: rgba(0, 155, 191, 0.1);
		border-color: rgba(0, 155, 191, 0.3);
		color: var(--line-3);
	}

	.defer-btn:hover:not(:disabled) {
		background: rgba(0, 155, 191, 0.2);
	}

	.apply-btn {
		background: rgba(143, 118, 214, 0.1);
		border-color: rgba(143, 118, 214, 0.3);
		color: var(--line-6);
	}

	.apply-btn:hover:not(:disabled) {
		background: rgba(143, 118, 214, 0.2);
	}

	/* Footer meta */
	.card-footer-meta {
		display: flex;
		justify-content: space-between;
		margin-top: 12px;
		padding-top: 8px;
	}

	.footer-id,
	.footer-modified {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		opacity: 0.6;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-bar::after {
			animation: none;
		}

		.expand-icon {
			transition: none;
		}
	}
</style>
