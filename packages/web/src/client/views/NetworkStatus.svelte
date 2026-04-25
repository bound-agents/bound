<script lang="ts">
import { onDestroy, onMount } from "svelte";
import LineBadge from "../components/LineBadge.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import StatusChip from "../components/StatusChip.svelte";
import TicketTab from "../components/TicketTab.svelte";
import TopologyDiagram from "../components/TopologyDiagram.svelte";
import { client } from "../lib/bound";

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
	localSiteId: string;
}

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

let networkData: NetworkData | null = $state(null);
let loading = $state(true);
let error = $state<string | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function loadNetwork(): Promise<void> {
	try {
		networkData = (await client.getNetwork()) as unknown as NetworkData;
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

function isLocal(host: HostInfo): boolean {
	return networkData?.localSiteId === host.site_id;
}

function isOnline(host: HostInfo): boolean {
	if (isLocal(host)) return true;
	if (!host.online_at) return false;
	return Date.now() - new Date(host.online_at).getTime() < ONLINE_THRESHOLD_MS;
}

function relativeTime(iso: string | null): string {
	if (!iso) return "never";
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function getSyncForPeer(peerSiteId: string): SyncStateInfo | null {
	if (!networkData) return null;
	return networkData.syncState.find((s) => s.peer_site_id === peerSiteId) ?? null;
}

function computeSyncHealth(
	s: SyncStateInfo | null,
): "healthy" | "degraded" | "unreachable" | "unknown" {
	if (!s || !s.last_sync_at) return "unknown";
	const lastSyncMs = Date.now() - new Date(s.last_sync_at).getTime();
	const fiveMinutesMs = 5 * 60 * 1000;
	const tenMinutesMs = 10 * 60 * 1000;
	if (lastSyncMs > tenMinutesMs) return "unreachable";
	if (s.sync_errors > 0) return "degraded";
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

const syncHealthMap = $derived.by(() => {
	const map = new Map<string, "healthy" | "degraded" | "unreachable" | "unknown">();
	if (!networkData) return map;
	for (const host of networkData.hosts) {
		const s = getSyncForPeer(host.site_id);
		map.set(host.site_id, computeSyncHealth(s));
	}
	return map;
});

interface MeshRow {
	id: string;
	peer: string;
	sent: string;
	received: string;
	lastSync: string;
	errors: number;
}

const syncMeshRows = $derived.by<MeshRow[]>(() => {
	const nd = networkData;
	if (!nd) return [];
	return nd.syncState
		.map((sync: SyncStateInfo): MeshRow => {
			const hostEntry = nd.hosts.find((h) => h.site_id === sync.peer_site_id);
			return {
				id: sync.peer_site_id,
				peer: hostEntry?.host_name ?? sync.peer_site_id.slice(0, 10),
				sent: sync.last_sent,
				received: sync.last_received,
				lastSync: relativeTime(sync.last_sync_at),
				errors: sync.sync_errors,
			};
		})
		.sort((a: MeshRow, b: MeshRow) => a.peer.localeCompare(b.peer));
});
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={3} subtitle="Cluster Topology" title="Network">
			{#snippet actions()}
				<TicketTab>
					{#snippet children()}Auto-refresh 10s{/snippet}
				</TicketTab>
			{/snippet}
		</SectionHeader>

		{#if loading}
			<div class="state">
				<p>Scanning network…</p>
			</div>
		{:else if error}
			<div class="state err">
				<p>{error}</p>
			</div>
		{:else if networkData}
			<TopologyDiagram
				hosts={networkData.hosts}
				hub={networkData.hub}
				syncHealth={syncHealthMap}
				localSiteId={networkData.localSiteId}
			/>

			<div class="host-grid">
				{#each networkData.hosts as host, idx (host.site_id)}
					{@const online = isOnline(host)}
					{@const isHub = networkData.hub?.hostName === host.host_name}
					{@const syncState = getSyncForPeer(host.site_id)}
					{@const health = computeSyncHealth(syncState)}
					{@const models = parseModels(host.models)}
					{@const mcpTools = parseMcpTools(host.mcp_tools)}
					{@const stateColor =
						!online
							? "var(--err)"
							: health === "healthy"
								? "var(--ok)"
								: health === "degraded"
									? "var(--warn)"
									: health === "unreachable"
										? "var(--err)"
										: "var(--ink-3)"}
					<div class="host-card">
						<div class="band" style="background: {stateColor}"></div>
						<div class="card-body">
							<div class="card-top">
								<LineBadge lineIndex={idx + 2} size="compact" />
								<div class="card-title">
									<h3>{host.host_name}</h3>
									<div class="site-id mono">{host.site_id.slice(0, 12)}</div>
								</div>
								<div class="card-right">
									{#if isHub}
										<span class="hub-badge">HUB</span>
									{/if}
									<StatusChip status={online ? "online" : "offline"} />
								</div>
							</div>

							<div class="fields">
								{#if host.version}
									<div class="row">
										<span class="kicker">Version</span>
										<span class="mono">{host.version}</span>
									</div>
								{/if}
								<div class="row">
									<span class="kicker">Last seen</span>
									<span class="mono">{relativeTime(host.online_at)}</span>
								</div>
								<div class="row">
									<span class="kicker">Sync</span>
									<span class="mono" style="color: {stateColor}">
										{health.toUpperCase()}
									</span>
								</div>
								<div class="row">
									<span class="kicker">Errors (24h)</span>
									<span
										class="mono"
										style="color: {syncState && syncState.sync_errors > 0 ? 'var(--err)' : 'var(--ink-2)'}"
									>
										{syncState?.sync_errors ?? 0}
									</span>
								</div>
							</div>

							{#if models.length > 0}
								<div class="pill-area">
									<div class="kicker pill-label">Models</div>
									<div class="pills">
										{#each models as m}
											<span class="pill">{m}</span>
										{/each}
									</div>
								</div>
							{/if}

							{#if mcpTools.length > 0}
								<div class="pill-area">
									<div class="kicker pill-label">MCP Tools</div>
									<div class="pills">
										{#each mcpTools as t}
											<span class="pill pill-outline">{t}</span>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			{#if syncMeshRows.length > 0}
				<div class="mesh">
					<div class="mesh-header">
						<h2 class="mesh-title">Sync Mesh</h2>
						<span class="mesh-sub kicker">Peer → Peer Replication</span>
					</div>
					<div class="mesh-columns">
						<span>Peer</span>
						<span>Sent</span>
						<span>Received</span>
						<span>Last Sync</span>
						<span class="right">Errors</span>
					</div>
					{#each syncMeshRows as row (row.id)}
						<div class="mesh-row">
							<span class="peer">{row.peer}</span>
							<span class="mono tnum">{row.sent?.toString().slice(0, 10) ?? "—"}</span>
							<span class="mono tnum">{row.received?.toString().slice(0, 10) ?? "—"}</span>
							<span class="mono">{row.lastSync}</span>
							<span
								class="mono tnum right"
								style="color: {row.errors > 0 ? 'var(--err)' : 'var(--ink-3)'}"
							>
								{row.errors}
							</span>
						</div>
					{/each}
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

	.state.err {
		color: var(--err);
	}

	.host-grid {
		margin-top: 28px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 16px;
	}

	.host-card {
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		position: relative;
		overflow: hidden;
	}

	.band {
		height: 6px;
	}

	.card-body {
		padding: 16px 18px 14px;
	}

	.card-top {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}

	.card-title {
		flex: 1;
		min-width: 0;
	}

	.card-title h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.site-id {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.08em;
		margin-top: 1px;
	}

	.card-right {
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: flex-end;
	}

	.hub-badge {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.22em;
		color: var(--paper);
		background: var(--ink);
		padding: 2px 6px;
	}

	.fields {
		border-top: 1px solid var(--rule-faint);
		padding-top: 12px;
		display: flex;
		flex-direction: column;
	}

	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 4px 0;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-4);
	}

	.mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 12px;
		color: var(--ink);
	}

	.pill-area {
		margin-top: 12px;
	}

	.pill-label {
		margin-bottom: 6px;
	}

	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.pill {
		padding: 3px 7px;
		background: var(--paper-3);
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-2);
	}

	.pill-outline {
		background: transparent;
		border: 1px solid var(--rule-soft);
		color: var(--ink-3);
	}

	.mesh {
		margin-top: 36px;
	}

	.mesh-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 12px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--ink);
	}

	.mesh-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 20px;
		font-weight: 600;
		color: var(--ink);
	}

	.mesh-sub {
		font-size: 11px;
		color: var(--ink-3);
	}

	.mesh-columns {
		display: grid;
		grid-template-columns: 1fr 120px 120px 120px 90px;
		gap: 14px;
		padding: 10px 0;
		border-bottom: 1px solid var(--rule-soft);
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.right {
		text-align: right;
	}

	.mesh-row {
		display: grid;
		grid-template-columns: 1fr 120px 120px 120px 90px;
		gap: 14px;
		padding: 14px 0;
		border-bottom: 1px solid var(--rule-faint);
		align-items: center;
	}

	.peer {
		font-family: var(--font-display);
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ink);
	}
</style>
