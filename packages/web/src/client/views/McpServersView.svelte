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

interface McpServerHost {
	site_id: string;
	host_name: string;
	online_at: string | null;
	has_capability_data: boolean;
}

interface McpDivergence {
	field: string;
	message: string;
}

interface McpServer {
	name: string;
	hosts: McpServerHost[];
	serverInfo?: McpServerInfo;
	tools: McpTool[];
	prompts?: McpPrompt[];
	resources?: McpResource[];
	divergence: McpDivergence[];
}

let servers: McpServer[] = $state([]);
let loading = $state(true);
let expandedName = $state<string | null>(null);
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function loadServers(): Promise<void> {
	try {
		const res = await fetch("/api/mcp/servers");
		if (res.ok) {
			const body = (await res.json()) as { servers: McpServer[] };
			servers = body.servers;
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

function toggleExpanded(name: string): void {
	expandedName = expandedName === name ? null : name;
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
	parts.push(plural(server.hosts.length, "host"));
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
		{:else if servers.length === 0}
			<div class="state">
				<p>No MCP servers connected anywhere in the cluster.</p>
			</div>
		{:else}
			<div class="server-list">
				{#each servers as server (server.name)}
					{@const expanded = expandedName === server.name}
					<div class="server" class:expanded>
						<button class="server-row" onclick={() => toggleExpanded(server.name)}>
							<span class="server-title">
								<span class="server-name">{server.name}</span>
								{#if server.serverInfo?.version}
									<span class="server-version">v{server.serverInfo.version}</span>
								{/if}
								{#if server.divergence.length > 0}
									<span class="divergence-badge" title="Hosts disagree about this server's capabilities">
										⚠ divergent
									</span>
								{/if}
							</span>
							<span class="server-meta">
								{serverSummary(server)}
								<span class="chevron">{expanded ? "▾" : "▸"}</span>
							</span>
						</button>

						{#if expanded}
							<div class="server-detail">
								<h3 class="subsection">Available on</h3>
								<div class="host-chips">
									{#each server.hosts as host (host.site_id)}
										<span
											class="host-chip"
											class:partial={!host.has_capability_data}
											title={formatLastSeen(host.online_at)}
										>
											{host.host_name}
											{#if !host.has_capability_data}
												<span class="partial-tag">partial inventory</span>
											{/if}
										</span>
									{/each}
								</div>
								{#if server.hosts.some((h) => !h.has_capability_data)}
									<p class="detail-note">
										Hosts marked “partial inventory” are running an older build that
										only records annotation hints; they're excluded from divergence
										comparison.
									</p>
								{/if}

								{#if server.divergence.length > 0}
									<h3 class="subsection">Divergence warnings</h3>
									{#each server.divergence as warning (warning.field)}
										<div class="warning">
											<span class="warning-field">{warning.field}</span>
											<span class="warning-message">{warning.message}</span>
										</div>
									{/each}
								{/if}

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
											No capability data captured for this server — every host carrying
											it may be running an older build that only records annotation
											hints.
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
	{/snippet}
</Page>

<style>
	.state {
		padding: 48px 0;
		text-align: center;
		color: var(--ink-3);
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

	.divergence-badge {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, #b3261e 40%, transparent);
		color: #b3261e;
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

	.host-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.host-chip {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		font-size: 12px;
		color: var(--ink-2);
		padding: 2px 8px;
		border: 1px solid var(--rule-soft);
	}

	.host-chip.partial {
		border-style: dashed;
	}

	.partial-tag {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-3);
	}

	.detail-note {
		font-size: 11px;
		color: var(--ink-3);
		margin: 2px 0 0;
	}

	.warning {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 6px 10px;
		border: 1px solid color-mix(in srgb, #b3261e 40%, transparent);
		background: color-mix(in srgb, #b3261e 6%, transparent);
	}

	.warning-field {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #b3261e;
		flex-shrink: 0;
	}

	.warning-message {
		font-size: 12px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
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
