<script lang="ts">
import { onDestroy, onMount } from "svelte";

interface HostInfo {
	site_id: string;
	host_name: string;
	version: string | null;
	sync_url: string | null;
	online_at: string | null;
	models: string | null;
	mcp_servers: string | null;
	modified_at: string;
}

interface SyncStateInfo {
	peer_site_id: string;
	last_received: number;
	last_sent: number;
	last_sync_at: string | null;
	sync_errors: number;
}

interface NetworkData {
	hosts: HostInfo[];
	hub: string | null;
	syncState: SyncStateInfo[];
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
let networkData: NetworkData | null = $state(null);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let loading = $state(true);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let error = $state<string | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function loadNetwork(): Promise<void> {
	try {
		const response = await fetch("/api/status/network");
		if (!response.ok) {
			const errData = await response.json();
			error = errData.error ?? "Failed to load network data";
			return;
		}
		networkData = await response.json();
		error = null;
	} catch (err) {
		console.error("Failed to load network status:", err);
		error = "Network request failed";
	}
	loading = false;
}

onMount(() => {
	loadNetwork();
	pollInterval = setInterval(loadNetwork, 10000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

// biome-ignore lint/correctness/noUnusedVariables: used in template
function isOnline(host: HostInfo): boolean {
	if (!host.online_at) return false;
	const lastSeen = new Date(host.online_at).getTime();
	const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
	return lastSeen > fiveMinutesAgo;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function truncateSiteId(siteId: string): string {
	if (siteId.length <= 12) return siteId;
	return `${siteId.substring(0, 6)}...${siteId.substring(siteId.length - 4)}`;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function relativeTime(iso: string | null): string {
	if (!iso) return "never";
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 0) return "just now";
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function getSyncForPeer(peerSiteId: string): SyncStateInfo | null {
	if (!networkData) return null;
	return networkData.syncState.find((s) => s.peer_site_id === peerSiteId) ?? null;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function syncHealthClass(syncState: SyncStateInfo | null): string {
	if (!syncState) return "sync-unknown";
	if (syncState.sync_errors > 5) return "sync-error";
	if (syncState.sync_errors > 0) return "sync-warning";
	return "sync-healthy";
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function syncHealthLabel(syncState: SyncStateInfo | null): string {
	if (!syncState) return "No sync data";
	if (syncState.sync_errors > 5) return `${syncState.sync_errors} errors`;
	if (syncState.sync_errors > 0) return `${syncState.sync_errors} warning(s)`;
	if (syncState.last_sync_at) return "Healthy";
	return "Pending";
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function parseModels(modelsStr: string | null): string[] {
	if (!modelsStr) return [];
	try {
		const parsed = JSON.parse(modelsStr);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
</script>

<div class="network-status">
	<div class="network-header">
		<h1>Network Status</h1>
		<span class="subtitle">Cluster Topology</span>
	</div>

	{#if loading}
		<div class="loading-state">
			<div class="loading-ring"></div>
			<p>Scanning network...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<svg width="32" height="32" viewBox="0 0 32 32">
				<circle cx="16" cy="16" r="14" fill="none" stroke="var(--alert-disruption)" stroke-width="2" opacity="0.6" />
				<path d="M16 10V18" stroke="var(--alert-disruption)" stroke-width="2.5" stroke-linecap="round" />
				<circle cx="16" cy="22" r="1.5" fill="var(--alert-disruption)" />
			</svg>
			<p>{error}</p>
		</div>
	{:else if networkData}
		<!-- Hub indicator -->
		{#if networkData.hub}
			<div class="hub-banner">
				<svg width="16" height="16" viewBox="0 0 16 16">
					<circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-4)" stroke-width="2" />
					<circle cx="8" cy="8" r="2.5" fill="var(--line-4)" />
				</svg>
				<span class="hub-label">Hub:</span>
				<span class="hub-name">{networkData.hub}</span>
			</div>
		{/if}

		{#if networkData.hosts.length === 0}
			<div class="empty-state">
				<p>No hosts registered in the cluster.</p>
			</div>
		{:else}
			<div class="hosts-grid">
				{#each networkData.hosts as host, idx}
					{@const online = isOnline(host)}
					{@const isHub = networkData.hub === host.host_name}
					{@const syncState = getSyncForPeer(host.site_id)}
					{@const models = parseModels(host.models)}
					<div class="host-card" class:host-online={online} class:host-offline={!online} class:host-hub={isHub}>
						<div class="card-header">
							<div class="host-badge">
								<svg width="36" height="36" viewBox="0 0 36 36">
									<circle cx="18" cy="18" r="16" fill="none" stroke={online ? "var(--line-4)" : "var(--alert-disruption)"} stroke-width="2.5" />
									{#if isHub}
										<circle cx="18" cy="18" r="10" fill="none" stroke={online ? "var(--line-4)" : "var(--alert-disruption)"} stroke-width="1.5" opacity="0.4" />
									{/if}
									<text
										x="18"
										y="18"
										font-size="14"
										font-weight="700"
										fill={online ? "var(--line-4)" : "var(--alert-disruption)"}
										text-anchor="middle"
										dominant-baseline="central"
										font-family="'Nunito Sans', sans-serif"
									>{isHub ? "H" : String.fromCharCode(65 + idx)}</text>
								</svg>
							</div>
							<div class="host-info">
								<div class="host-name-row">
									<h2>{host.host_name}</h2>
									{#if isHub}
										<span class="hub-chip">HUB</span>
									{/if}
								</div>
								<div class="status-line">
									<span class="status-dot" class:online={online}></span>
									<span class="status-text" class:text-online={online} class:text-offline={!online}>
										{online ? "Online" : "Offline"}
									</span>
								</div>
							</div>
						</div>

						<div class="card-details">
							<div class="detail-row">
								<span class="detail-label">Site ID</span>
								<span class="detail-value mono-value" title={host.site_id}>
									{truncateSiteId(host.site_id)}
								</span>
							</div>
							<div class="detail-row">
								<span class="detail-label">Last seen</span>
								<span class="detail-value time-value">
									{relativeTime(host.online_at)}
								</span>
							</div>
							{#if host.version}
								<div class="detail-row">
									<span class="detail-label">Version</span>
									<span class="detail-value mono-value">{host.version}</span>
								</div>
							{/if}
							{#if host.sync_url}
								<div class="detail-row">
									<span class="detail-label">Sync URL</span>
									<span class="detail-value mono-value" title={host.sync_url}>
										{host.sync_url.length > 28 ? `${host.sync_url.substring(0, 26)}...` : host.sync_url}
									</span>
								</div>
							{/if}

							<!-- Sync health -->
							<div class="detail-row">
								<span class="detail-label">Sync</span>
								<span class="detail-value sync-indicator {syncHealthClass(syncState)}">
									<span class="sync-dot"></span>
									{syncHealthLabel(syncState)}
								</span>
							</div>
							{#if syncState?.last_sync_at}
								<div class="detail-row">
									<span class="detail-label">Last sync</span>
									<span class="detail-value time-value">{relativeTime(syncState.last_sync_at)}</span>
								</div>
							{/if}

							<!-- Models -->
							{#if models.length > 0}
								<div class="detail-row">
									<span class="detail-label">Models</span>
									<span class="detail-value model-list">
										{models.slice(0, 3).join(", ")}{models.length > 3 ? ` +${models.length - 3}` : ""}
									</span>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			<!-- Sync mesh visualization -->
			{#if networkData.syncState.length > 0}
				<div class="sync-mesh">
					<h3>Sync Mesh</h3>
					<div class="mesh-table">
						<div class="mesh-header">
							<span class="mesh-col">Peer</span>
							<span class="mesh-col">Sent</span>
							<span class="mesh-col">Received</span>
							<span class="mesh-col">Last Sync</span>
							<span class="mesh-col">Errors</span>
						</div>
						{#each networkData.syncState as sync}
							<div class="mesh-row">
								<span class="mesh-col mono-value" title={sync.peer_site_id}>{truncateSiteId(sync.peer_site_id)}</span>
								<span class="mesh-col mono-value">{sync.last_sent}</span>
								<span class="mesh-col mono-value">{sync.last_received}</span>
								<span class="mesh-col time-value">{relativeTime(sync.last_sync_at)}</span>
								<span class="mesh-col" class:mesh-errors={sync.sync_errors > 0}>
									{sync.sync_errors}
								</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.network-status {
		padding: 32px 40px;
		max-width: 1120px;
		margin: 0 auto;
	}

	.network-header {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin-bottom: 32px;
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

	.loading-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 64px 0;
	}

	.loading-ring {
		width: 32px;
		height: 32px;
		border: 3px solid var(--bg-surface);
		border-top-color: var(--line-4);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.loading-state p {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}

	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 64px 0;
	}

	.error-state p {
		color: var(--alert-disruption);
		font-size: var(--text-sm);
		margin: 0;
	}

	.empty-state {
		padding: 48px 0;
		text-align: center;
	}

	.empty-state p {
		color: var(--text-muted);
		font-size: var(--text-sm);
		margin: 0;
	}

	/* Hub banner */
	.hub-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 20px;
		background: rgba(0, 153, 68, 0.06);
		border: 1px solid rgba(0, 153, 68, 0.2);
		border-radius: 8px;
		margin-bottom: 24px;
	}

	.hub-label {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.hub-name {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--line-4);
		font-weight: 600;
	}

	.hosts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
		gap: 24px;
	}

	.host-card {
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		padding: 24px;
		transition: all 0.2s ease;
	}

	.host-card:hover {
		border-color: var(--line-4);
		box-shadow: 0 0 16px rgba(0, 153, 68, 0.08);
	}

	.host-card.host-online {
		border-top: 3px solid var(--line-4);
	}

	.host-card.host-offline {
		border-top: 3px solid var(--alert-disruption);
	}

	.host-card.host-hub {
		box-shadow: 0 0 0 1px rgba(0, 153, 68, 0.15);
	}

	.card-header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 20px;
	}

	.host-badge {
		flex-shrink: 0;
	}

	.host-info {
		flex: 1;
	}

	.host-name-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 6px;
	}

	h2 {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 700;
	}

	.hub-chip {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		color: var(--line-4);
		background: rgba(0, 153, 68, 0.12);
		border: 1px solid rgba(0, 153, 68, 0.3);
		padding: 1px 6px;
		border-radius: 3px;
		letter-spacing: 0.06em;
	}

	.status-line {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--alert-disruption);
		transition: background 0.2s ease;
	}

	.status-dot.online {
		background: var(--status-active);
		box-shadow: 0 0 6px rgba(105, 240, 174, 0.4);
	}

	.status-text {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.text-online {
		color: var(--status-active);
	}

	.text-offline {
		color: var(--alert-disruption);
	}

	.card-details {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 16px;
		border-top: 1px solid rgba(15, 52, 96, 0.5);
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.detail-label {
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.detail-value {
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.mono-value {
		font-family: var(--font-mono);
		font-size: 12px;
	}

	.time-value {
		font-family: var(--font-mono);
		font-size: 12px;
	}

	.model-list {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
	}

	/* Sync health indicators */
	.sync-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
	}

	.sync-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.sync-healthy {
		color: var(--status-active);
	}

	.sync-healthy .sync-dot {
		background: var(--status-active);
	}

	.sync-warning {
		color: var(--alert-warning);
	}

	.sync-warning .sync-dot {
		background: var(--alert-warning);
	}

	.sync-error {
		color: var(--alert-disruption);
	}

	.sync-error .sync-dot {
		background: var(--alert-disruption);
	}

	.sync-unknown {
		color: var(--text-muted);
	}

	.sync-unknown .sync-dot {
		background: var(--text-muted);
	}

	/* Sync mesh table */
	.sync-mesh {
		margin-top: 40px;
	}

	.sync-mesh h3 {
		margin: 0 0 16px 0;
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 700;
		color: var(--text-primary);
	}

	.mesh-table {
		background: rgba(10, 10, 20, 0.5);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		overflow: hidden;
	}

	.mesh-header {
		display: grid;
		grid-template-columns: 1fr 80px 80px 120px 80px;
		padding: 12px 20px;
		background: var(--bg-secondary);
		border-bottom: 2px solid var(--bg-surface);
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 700;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.mesh-row {
		display: grid;
		grid-template-columns: 1fr 80px 80px 120px 80px;
		padding: 10px 20px;
		border-bottom: 1px solid rgba(15, 52, 96, 0.4);
		align-items: center;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.mesh-row:last-child {
		border-bottom: none;
	}

	.mesh-errors {
		color: var(--alert-disruption);
		font-weight: 700;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-ring {
			animation: none;
		}
	}
</style>
