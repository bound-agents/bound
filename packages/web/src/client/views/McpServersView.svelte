<script lang="ts">
import { onDestroy, onMount } from "svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";

interface McpServerInfo {
	name?: string;
	title?: string;
	version?: string;
	description?: string;
	instructions?: string;
}

interface McpTool {
	name: string;
	description?: string;
	annotations: Record<string, boolean>;
}

interface McpPrompt {
	name: string;
	description?: string;
}

interface McpResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

interface McpServer {
	name: string;
	serverInfo?: McpServerInfo;
	tools: McpTool[];
	prompts?: McpPrompt[];
	resources?: McpResource[];
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
 * Hosts that pre-date full capability capture only report tools that
 * declared annotation hints; hosts on current code report the complete
 * surface (serverInfo, tools, prompts, resources).
 */
function hasCapabilityData(server: McpServer): boolean {
	return (
		server.serverInfo !== undefined ||
		server.prompts !== undefined ||
		server.resources !== undefined
	);
}

function serverSummary(server: McpServer): string {
	const parts: string[] = [];
	const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
	if (hasCapabilityData(server)) {
		parts.push(plural(server.tools.length, "tool"));
		if (server.prompts !== undefined) parts.push(plural(server.prompts.length, "prompt"));
		if (server.resources !== undefined) parts.push(plural(server.resources.length, "resource"));
	} else if (server.tools.length > 0) {
		parts.push(`${plural(server.tools.length, "annotated tool")}`);
	} else {
		parts.push("no capability data");
	}
	return parts.join(" · ");
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
										<span class="server-title">
											<span class="server-name">{server.name}</span>
											{#if server.serverInfo?.version}
												<span class="server-version">v{server.serverInfo.version}</span>
											{/if}
										</span>
										<span class="server-meta">
											{serverSummary(server)}
											<span class="chevron">{expanded ? "▾" : "▸"}</span>
										</span>
									</button>

									{#if expanded}
										<div class="server-detail">
											{#if server.serverInfo}
												{@const info = server.serverInfo}
												<div class="server-info">
													{#if info.title || info.name}
														<div class="info-identity">
															<span class="info-title">{info.title ?? info.name}</span>
															{#if info.title && info.name && info.title !== info.name}
																<span class="info-impl">{info.name}</span>
															{/if}
															{#if info.version}
																<span class="info-impl">v{info.version}</span>
															{/if}
														</div>
													{/if}
													{#if info.description}
														<p class="info-desc">{info.description}</p>
													{/if}
													{#if info.instructions}
														<details class="info-instructions">
															<summary>Instructions to agents</summary>
															<p>{info.instructions}</p>
														</details>
													{/if}
												</div>
											{/if}

											<h3 class="subsection">Tools</h3>
											{#if server.tools.length === 0}
												{#if hasCapabilityData(server)}
													<p class="detail-empty">This server exposes no tools.</p>
												{:else}
													<p class="detail-empty">
														No capability data captured for this server — the host may be
														running an older build that only records annotation hints.
													</p>
												{/if}
											{:else}
												{#each server.tools as tool (tool.name)}
													<div class="tool">
														<div class="tool-main">
															<span class="tool-name">{tool.name}</span>
															{#if tool.description}
																<span class="item-desc">{tool.description}</span>
															{/if}
														</div>
														<span class="chips">
															{#each annotationChips(tool.annotations) as chip}
																<span class="chip {chip.tone}">{chip.text}</span>
															{/each}
														</span>
													</div>
												{/each}
											{/if}

											{#if server.prompts !== undefined}
												<h3 class="subsection">Prompts</h3>
												{#if server.prompts.length === 0}
													<p class="detail-empty">This server exposes no prompts.</p>
												{:else}
													{#each server.prompts as prompt (prompt.name)}
														<div class="tool">
															<div class="tool-main">
																<span class="tool-name">{prompt.name}</span>
																{#if prompt.description}
																	<span class="item-desc">{prompt.description}</span>
																{/if}
															</div>
														</div>
													{/each}
												{/if}
											{/if}

											{#if server.resources !== undefined}
												<h3 class="subsection">Resources</h3>
												{#if server.resources.length === 0}
													<p class="detail-empty">This server exposes no resources.</p>
												{:else}
													{#each server.resources as resource (resource.uri)}
														<div class="tool">
															<div class="tool-main">
																<span class="tool-name">{resource.name ?? resource.uri}</span>
																{#if resource.name}
																	<span class="resource-uri">{resource.uri}</span>
																{/if}
																{#if resource.description}
																	<span class="item-desc">{resource.description}</span>
																{/if}
															</div>
															{#if resource.mimeType}
																<span class="chips">
																	<span class="chip neutral">{resource.mimeType}</span>
																</span>
															{/if}
														</div>
													{/each}
												{/if}
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

	.server-title {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.server-name {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
	}

	.server-version {
		font-size: 11px;
		color: var(--ink-3);
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

	.server-detail {
		border-top: 1px solid var(--rule-soft);
		padding: 8px 16px 12px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.server-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 4px 0 8px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.info-identity {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.info-title {
		font-family: var(--font-display);
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.info-impl {
		font-size: 11px;
		color: var(--ink-3);
	}

	.info-desc {
		font-size: 12px;
		color: var(--ink-2);
		margin: 0;
	}

	.info-instructions {
		font-size: 12px;
		color: var(--ink-2);
	}

	.info-instructions summary {
		cursor: pointer;
		font-size: 11px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.info-instructions p {
		margin: 4px 0 0;
		white-space: pre-wrap;
	}

	.subsection {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-3);
		margin: 8px 0 0;
	}

	.detail-empty {
		font-size: 12px;
		color: var(--ink-3);
		margin: 4px 0 0;
	}

	.tool {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 12px;
		padding: 4px 0;
	}

	.tool-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.tool-name {
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.resource-uri {
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.item-desc {
		font-size: 12px;
		color: var(--ink-3);
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