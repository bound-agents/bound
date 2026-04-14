<script lang="ts">
import { onDestroy, onMount } from "svelte";
import {
	DataTable,
	LineBadge,
	MetroCard,
	SectionHeader,
	StatusChip,
	TopologyDiagram,
} from "../components/shared";
import { getLineColor } from "../lib/metro-lines";

interface HostInfo {
	site_id: string;
	host_name: string;
	version: string | null;
	sync_url: string | null;
	online_at: string | null;
	models: string | null;
	mcp_tools: string | null;
	modified_at: string;
}

interface SyncStateInfo {
	peer_site_id: string;
	last_received: string;
	last_sent: string;
	last_sync_at: string | null;
	sync_errors: number;
}

interface NetworkData {
	hosts: HostInfo[];
	hub: { siteId: string; hostName: string } | null;
	syncState: SyncStateInfo[];
}

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

let networkData: NetworkData | null = $state(null);
let loading = $state(true);
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

function isOnline(host: HostInfo): boolean {
	if (!host.online_at) return false;
	const lastSeen = new Date(host.online_at).getTime();
	return Date.now() - lastSeen < ONLINE_THRESHOLD_MS;
}

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

function truncateSiteId(siteId: string): string {
	if (siteId.length <= 12) return siteId;
	return `${siteId.substring(0, 6)}...${siteId.substring(siteId.length - 4)}`;
}

function getSyncForPeer(peerSiteId: string): SyncStateInfo | null {
	if (!networkData) return null;
	return networkData.syncState.find((s) => s.peer_site_id === peerSiteId) ?? null;
}

function computeSyncHealth(
	syncState: SyncStateInfo | null,
): "healthy" | "degraded" | "unreachable" | "unknown" {
	if (!syncState) return "unknown";
	if (!syncState.last_sync_at) return "unknown";
	const lastSyncMs = Date.now() - new Date(syncState.last_sync_at).getTime();
	const fiveMinutesMs = 5 * 60 * 1000;
	const tenMinutesMs = 10 * 60 * 1000;

	if (lastSyncMs > tenMinutesMs) return "unreachable";
	if (syncState.sync_errors > 0) return "degraded";
	if (lastSyncMs < fiveMinutesMs) return "healthy";
	return "degraded";
}

function parseModels(modelsStr: string | null): string[] {
	if (!modelsStr) return [];
	try {
		const parsed = JSON.parse(modelsStr);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((entry: unknown) =>
			typeof entry === "string" ? entry : ((entry as { id?: string })?.id ?? "unknown"),
		);
	} catch {
		return [];
	}
}

function parseMcpTools(toolsStr: string | null): string[] {
	if (!toolsStr) return [];
	try {
		const parsed = JSON.parse(toolsStr);
		if (!Array.isArray(parsed)) return [];
		return parsed as string[];
	} catch {
		return [];
	}
}

function buildSyncHealthMap(): Map<string, "healthy" | "degraded" | "unreachable" | "unknown"> {
	const map = new Map<string, "healthy" | "degraded" | "unreachable" | "unknown">();
	if (!networkData) return map;

	for (const host of networkData.hosts) {
		const syncState = getSyncForPeer(host.site_id);
		map.set(host.site_id, computeSyncHealth(syncState));
	}
	return map;
}

function copyToClipboard(text: string): void {
	navigator.clipboard.writeText(text);
}

const syncHealthMap = $derived(buildSyncHealthMap());

const syncMeshRows = $derived(
	networkData
		? networkData.syncState
				.map((sync) => {
					const hostEntry = networkData?.hosts.find((h) => h.site_id === sync.peer_site_id);
					return {
						id: sync.peer_site_id,
						peer: hostEntry?.host_name || truncateSiteId(sync.peer_site_id),
						sent: sync.last_sent,
						received: sync.last_received,
						lastSync: relativeTime(sync.last_sync_at),
						errors: sync.sync_errors,
					};
				})
				.sort((a, b) => a.peer.localeCompare(b.peer))
		: [],
);

const syncMeshColumns = [
	{ key: "peer", label: "Peer", width: "1fr" },
	{ key: "sent", label: "Sent", width: "120px", mono: true },
	{ key: "received", label: "Received", width: "120px", mono: true },
	{ key: "lastSync", label: "Last Sync", width: "100px", mono: true },
	{ key: "errors", label: "Errors", width: "60px", mono: true },
];
</script>

<div class="network-status">
	<SectionHeader title="Network Status" subtitle="CLUSTER TOPOLOGY" />

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
		<!-- Topology Diagram -->
		<TopologyDiagram hosts={networkData.hosts} hub={networkData.hub} syncHealth={syncHealthMap} />

		{#if networkData.hosts.length === 0}
			<div class="empty-state">
				<p>No hosts registered in the cluster.</p>
			</div>
		{:else}
			<!-- Host Cards Grid -->
			<div class="hosts-grid">
				{#each networkData.hosts as host, idx}
					{@const online = isOnline(host)}
					{@const isHub = networkData.hub?.hostName === host.host_name}
					{@const syncState = getSyncForPeer(host.site_id)}
					{@const models = parseModels(host.models)}
					{@const mcpTools = parseMcpTools(host.mcp_tools)}
					{@const health = computeSyncHealth(syncState)}
					{@const accentColor = getLineColor(idx)}
					<MetroCard {accentColor}>
						<div class="card-content">
							<div class="card-header">
								<LineBadge lineIndex={idx} size="compact" />
								<div class="header-text">
									<div class="host-title">
										<h3>{host.host_name}</h3>
										{#if isHub}
											<span class="hub-badge">HUB</span>
										{/if}
									</div>
									<StatusChip status={online ? "healthy" : "unreachable"} label={online ? "Online" : "Offline"} animate={false} />
								</div>
							</div>

							<div class="card-details">
								<div class="detail-row">
									<span class="detail-label">Site ID</span>
									<div class="detail-value-with-action">
										<code>{host.site_id}</code>
										<button
											class="copy-button"
											onclick={() => copyToClipboard(host.site_id)}
											title="Copy site ID"
											type="button"
										>
											📋
										</button>
									</div>
								</div>

								<div class="detail-row">
									<span class="detail-label">Last Seen</span>
									<span class="detail-value mono-value">{relativeTime(host.online_at)}</span>
								</div>

								{#if host.version}
									<div class="detail-row">
										<span class="detail-label">Version</span>
										<span class="detail-value mono-value">{host.version}</span>
									</div>
								{/if}

								<div class="detail-row">
									<span class="detail-label">Sync Status</span>
									<div class="sync-status">
										<StatusChip status={health} animate={false} />
									</div>
								</div>

								{#if syncState?.last_sync_at}
									<div class="detail-row">
										<span class="detail-label">Last Sync</span>
										<span class="detail-value mono-value">{relativeTime(syncState.last_sync_at)}</span>
									</div>
								{/if}

								{#if models.length > 0}
									<div class="detail-row">
										<span class="detail-label">Models</span>
										<div class="pills-list">
											{#each models.slice(0, 3) as model}
												<span class="pill">{model}</span>
											{/each}
											{#if models.length > 3}
												<span class="pill pill-overflow">+{models.length - 3}</span>
											{/if}
										</div>
									</div>
								{/if}

								{#if mcpTools.length > 0}
									<div class="detail-row">
										<span class="detail-label">MCP Tools</span>
										<div class="pills-list">
											{#each mcpTools.slice(0, 3) as tool}
												<span class="pill pill-secondary">{tool}</span>
											{/each}
											{#if mcpTools.length > 3}
												<span class="pill pill-secondary pill-overflow">+{mcpTools.length - 3}</span>
											{/if}
										</div>
									</div>
								{/if}
							</div>
						</div>
					</MetroCard>
				{/each}
			</div>

			<!-- Sync Mesh Table -->
			{#if networkData.syncState.length > 0}
				<div class="sync-mesh-section">
					<h2>Sync Mesh</h2>
					<DataTable
						columns={syncMeshColumns}
						rows={syncMeshRows}
						sortable={true}
						rowAccent={(row) => {
							if (row.errors > 0) return "var(--alert-disruption)";
							return null;
						}}
					/>
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.network-status {
		padding: 32px 40px;
		max-width: 1400px;
		margin: 0 auto;
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
		to {
			transform: rotate(360deg);
		}
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

	.hosts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
		gap: 16px;
		margin-bottom: 40px;
	}

	.card-content {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.card-header {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}

	.header-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.host-title {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	h3 {
		margin: 0;
		font-size: var(--text-lg);
		color: var(--text-primary);
		font-weight: 700;
	}

	.hub-badge {
		font-size: 10px;
		font-weight: 700;
		color: var(--line-4);
		background: rgba(0, 153, 68, 0.12);
		border: 1px solid rgba(0, 153, 68, 0.3);
		padding: 2px 6px;
		border-radius: 3px;
		letter-spacing: 0.06em;
	}

	.card-details {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--bg-surface);
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.detail-label {
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

	code {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-secondary);
		word-break: break-all;
	}

	.detail-value-with-action {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.copy-button {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 12px;
		padding: 2px 4px;
		opacity: 0.6;
		transition: opacity 0.15s ease;
	}

	.copy-button:hover {
		opacity: 1;
	}

	.sync-status {
		display: flex;
		align-items: center;
	}

	.pills-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.pill {
		font-size: 11px;
		padding: 4px 8px;
		border-radius: 12px;
		background: rgba(0, 153, 68, 0.1);
		color: var(--line-4);
		border: 1px solid rgba(0, 153, 68, 0.2);
		font-weight: 500;
	}

	.pill-secondary {
		background: rgba(100, 100, 150, 0.1);
		color: var(--text-secondary);
		border-color: rgba(100, 100, 150, 0.2);
	}

	.pill-overflow {
		background: rgba(15, 52, 96, 0.4);
		color: var(--text-muted);
		border-color: var(--bg-surface);
	}

	.sync-mesh-section {
		margin-top: 40px;
	}

	.sync-mesh-section h2 {
		margin: 0 0 16px 0;
		font-size: var(--text-lg);
		font-weight: 700;
		color: var(--text-primary);
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-ring {
			animation: none;
		}
	}
</style>
