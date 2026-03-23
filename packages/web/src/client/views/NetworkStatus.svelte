<script lang="ts">
import { onMount } from "svelte";

// biome-ignore lint/correctness/noUnusedVariables: used in template
let hosts = [];
// biome-ignore lint/correctness/noUnusedVariables: used in template
let loading = true;

onMount(async () => {
	try {
		const response = await fetch("/api/status");
		const status = await response.json();
		// Build host info from the fetched status
		const hostUptime = status.host_info?.uptime_seconds ?? 0;
		hosts = [
			{
				name: "localhost",
				online: true,
				syncStatus: "synced",
				lastSync: new Date(Date.now() - hostUptime * 1000).toISOString(),
			},
		];
	} catch (error) {
		console.error("Failed to load network status:", error);
	}
	loading = false;
});
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
	{:else}
		<div class="hosts-grid">
			{#each hosts as host, idx}
				<div class="host-card" class:host-online={host.online} class:host-offline={!host.online}>
					<div class="card-header">
						<div class="host-badge">
							<svg width="32" height="32" viewBox="0 0 32 32">
								<circle cx="16" cy="16" r="14" fill="none" stroke={host.online ? "var(--line-4)" : "var(--alert-disruption)"} stroke-width="2.5" />
								<text
									x="16"
									y="16"
									font-size="14"
									font-weight="700"
									fill={host.online ? "var(--line-4)" : "var(--alert-disruption)"}
									text-anchor="middle"
									dominant-baseline="central"
									font-family="'Nunito Sans', sans-serif"
								>{idx === 0 ? "H" : String.fromCharCode(65 + idx)}</text>
							</svg>
						</div>
						<div class="host-info">
							<h2>{host.name}</h2>
							<div class="status-line">
								<span class="status-dot" class:online={host.online}></span>
								<span class="status-text" class:text-online={host.online} class:text-offline={!host.online}>
									{host.online ? "Online" : "Offline"}
								</span>
							</div>
						</div>
					</div>

					<div class="card-details">
						<div class="detail-row">
							<span class="detail-label">Sync</span>
							<span class="detail-value sync-value" class:sync-ok={host.syncStatus === "synced"}>
								{host.syncStatus}
							</span>
						</div>
						<div class="detail-row">
							<span class="detail-label">Last seen</span>
							<span class="detail-value time-value">
								{new Date(host.lastSync).toLocaleString()}
							</span>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.network-status {
		padding: 32px 40px;
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

	.hosts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
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

	h2 {
		margin: 0 0 6px 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 700;
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

	.sync-value.sync-ok {
		color: var(--status-active);
		font-weight: 600;
	}

	.time-value {
		font-family: var(--font-mono);
		font-size: 12px;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-ring {
			animation: none;
		}
	}
</style>
