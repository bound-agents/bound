<script lang="ts">
import { onMount } from "svelte";

let hosts = [];
let loading = true;

onMount(async () => {
	try {
		const response = await fetch("/api/status");
		const status = await response.json();
		hosts = [
			{
				name: "localhost",
				online: true,
				syncStatus: "synced",
				lastSync: new Date().toISOString(),
			},
		];
	} catch (error) {
		console.error("Failed to load network status:", error);
	}
	loading = false;
});
</script>

<div class="network-status">
	<h1>Network Status</h1>

	{#if loading}
		<p>Loading network status...</p>
	{:else}
		<div class="hosts-grid">
			{#each hosts as host}
				<div class="host-card">
					<h2>{host.name}</h2>
					<div class="status-indicator" class:online={host.online} />
					<p class="status-text">
						{host.online ? "Online" : "Offline"}
					</p>
					<p class="sync-status">{host.syncStatus}</p>
					<p class="last-sync">Last sync: {new Date(host.lastSync).toLocaleString()}</p>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.network-status {
		padding: 20px;
	}

	h1 {
		margin-bottom: 30px;
		color: #e0e0e0;
	}

	.hosts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: 20px;
	}

	.host-card {
		background: #16213e;
		border: 1px solid #0f3460;
		border-radius: 8px;
		padding: 20px;
	}

	h2 {
		margin: 0 0 15px 0;
		color: #e0e0e0;
		font-size: 18px;
	}

	.status-indicator {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		display: inline-block;
		margin-right: 8px;
		background: #ff6b6b;
		transition: background 200ms;
	}

	.status-indicator.online {
		background: #00c994;
	}

	.status-text {
		display: inline;
		color: #e0e0e0;
		font-weight: 500;
		margin: 0 0 10px 0;
	}

	.sync-status {
		color: #888;
		font-size: 14px;
		margin: 10px 0 5px 0;
	}

	.last-sync {
		color: #666;
		font-size: 12px;
		margin: 5px 0 0 0;
	}
</style>
