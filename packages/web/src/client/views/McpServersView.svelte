<script lang="ts">
import { onDestroy, onMount } from "svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";

interface McpTool {
	name: string;
	annotations: Record<string, boolean>;
}

interface McpServer {
	name: string;
	tools: McpTool[];
}

interface McpHost {
	site_id: string;
	host_name: string;
	online_at: string | null;
	servers: McpServer[];
}

let hosts: McpHost[] = $state([]);
let loading = $state(true);
let expandedKey = $state<string | null>(null);
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function loadServers(): Promise<void> {
	try {
		const res = await fetch("/api/mcp/servers");
		if (res.ok) {
			const body = (await res.json()) as { hosts: McpHost[] };
			hosts = body.hosts;
		}
	} catch {
		// Transient fetch failure — keep the last good snapshot.
	}
	loading = false;
}

onMount(() => {
	loadServers();
	pollInterval = setInterval(loadServers, 30000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

function serverKey(host: McpHost, server: McpServer): string {
	return `${host.site_id}:${server.name}`;
}

function toggleExpanded(key: string): void {
	expandedKey = expandedKey === key ? null : key;
}

function formatLastSeen(onlineAt: string | null): string {
	if (!onlineAt) return "never seen";
	const date = new Date(onlineAt);
	if (Number.isNaN(date.getTime())) return "never seen";
	return `last seen ${date.toLocaleString()}`;
}

/**
 * Render the MCP-spec annotation hints as readable chips. Both polarities
 * are informative (an explicit `idempotentHint: false` is a real signal),
 * so present hints always render; absent hints render nothing.
 */
function annotationChips(annotations: Record<string, boolean>): Array<{
	text: string;
	tone: "safe" | "caution" | "neutral";
}> {
	const chips: Array<{ text: string; tone: "safe" | "caution" | "neutral" }> = [];
	if (annotations.readOnlyHint !== undefined) {
		chips.push(
			annotations.readOnlyHint
				? { text: "read-only", tone: "safe" }
				: { text: "writes", tone: "caution" },
		);
	}
	if (annotations.destructiveHint !== undefined) {
		chips.push(
			annotations.destructiveHint
				? { text: "destructive", tone: "caution" }
				: { text: "non-destructive", tone: "safe" },
		);
	}
	if (annotations.idempotentHint !== undefined) {
		chips.push(
			annotations.idempotentHint
				? { text: "idempotent", tone: "safe" }
				: { text: "non-idempotent", tone: "neutral" },
		);
	}
	return chips;
}
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={6} title="MCP Servers" subtitle="Cluster tool inventory" />

		{#if loading}
			<div class="state">
				<p>Loading MCP servers…</p>
			</div>
		{:else if hosts.length === 0}
			<div class="state">
				<p>No hosts registered.</p>
			</div>
		{:else}
			{#each hosts as host (host.site_id)}
				<section class="host">
					<header class="host-header">
						<h2 class="host-name">{host.host_name}</h2>
						<span class="host-meta">
							{host.servers.length}
							{host.servers.length === 1 ? "server" : "servers"} · {formatLastSeen(
								host.online_at,
							)}
						</span>
					</header>

					{#if host.servers.length === 0}
						<p class="host-empty">No MCP servers connected on this host.</p>
					{:else}
						<div class="server-list">
							{#each host.servers as server (server.name)}
								{@const key = serverKey(host, server)}
								{@const expanded = expandedKey === key}
								<div class="server" class:expanded>
									<button class="server-row" onclick={() => toggleExpanded(key)}>
										<span class="server-name">{server.name}</span>
										<span class="server-meta">
											{#if server.tools.length > 0}
												{server.tools.length} annotated
												{server.tools.length === 1 ? "tool" : "tools"}
											{:else}
												no annotation data
											{/if}
											<span class="chevron">{expanded ? "▾" : "▸"}</span>
										</span>
									</button>

									{#if expanded}
										<div class="tool-list">
											{#if server.tools.length === 0}
												<p class="tool-empty">
													No tool annotations captured for this server — it may still expose
													tools that don't declare MCP annotation hints.
												</p>
											{:else}
												{#each server.tools as tool (tool.name)}
													<div class="tool">
														<span class="tool-name">{tool.name}</span>
														<span class="chips">
															{#each annotationChips(tool.annotations) as chip}
																<span class="chip {chip.tone}">{chip.text}</span>
															{/each}
														</span>
													</div>
												{/each}
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		{/if}
	{/snippet}
</Page>

<style>
	.state {
		padding: 48px 0;
		text-align: center;
		color: var(--ink-3);
	}

	.host {
		margin-bottom: 32px;
	}

	.host-header {
		display: flex;
		align-items: baseline;
		gap: 12px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule-soft);
		margin-bottom: 12px;
	}

	.host-name {
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 600;
		margin: 0;
		color: var(--ink);
	}

	.host-meta {
		font-size: 12px;
		color: var(--ink-3);
	}

	.host-empty {
		font-size: 13px;
		color: var(--ink-3);
		margin: 0;
	}

	.server-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.server {
		border: 1px solid var(--rule-soft);
		background: var(--paper-2);
	}

	.server-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		padding: 12px 16px;
		background: none;
		border: none;
		cursor: pointer;
		font: inherit;
		color: var(--ink);
		text-align: left;
	}

	.server-row:hover {
		background: rgba(26, 24, 20, 0.04);
	}

	.server-name {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
	}

	.server-meta {
		font-size: 12px;
		color: var(--ink-3);
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.chevron {
		font-size: 10px;
	}

	.tool-list {
		border-top: 1px solid var(--rule-soft);
		padding: 8px 16px 12px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.tool-empty {
		font-size: 12px;
		color: var(--ink-3);
		margin: 4px 0 0;
	}

	.tool {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 4px 0;
	}

	.tool-name {
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.chips {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.chip {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 6px;
		border: 1px solid var(--rule-soft);
		color: var(--ink-2);
	}

	.chip.safe {
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		color: var(--accent-2);
	}

	.chip.caution {
		border-color: color-mix(in srgb, #b3261e 40%, transparent);
		color: #b3261e;
	}
</style>
