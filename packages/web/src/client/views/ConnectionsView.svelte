<script lang="ts">
import McpServersView from "./McpServersView.svelte";
import SkillsView from "./SkillsView.svelte";
import WebhookView from "./WebhookView.svelte";

export type ConnectionsSection = "webhooks" | "skills" | "mcp";

interface Props {
	section: ConnectionsSection;
}

let { section }: Props = $props();

const SECTIONS: { id: ConnectionsSection; label: string; desc: string; hash: string }[] = [
	{
		id: "webhooks",
		label: "Webhooks",
		desc: "Automated messaging endpoints",
		hash: "#/connections/webhooks",
	},
	{
		id: "skills",
		label: "Skills",
		desc: "Reusable instruction sets",
		hash: "#/connections/skills",
	},
	{
		id: "mcp",
		label: "MCP Servers",
		desc: "Cluster tool inventory",
		hash: "#/connections/mcp",
	},
];
</script>

<div class="connections">
	<aside class="sub-nav" aria-label="Connections sections">
		<div class="kicker">Connections</div>
		<nav>
			{#each SECTIONS as s}
				{@const active = section === s.id}
				<a
					class="sub-link"
					class:active
					href={s.hash}
					aria-current={active ? "page" : undefined}
				>
					<span class="sub-label">{s.label}</span>
					<span class="sub-desc">{s.desc}</span>
				</a>
			{/each}
		</nav>
	</aside>

	<div class="content">
		{#if section === "skills"}
			<SkillsView />
		{:else if section === "mcp"}
			<McpServersView />
		{:else}
			<WebhookView />
		{/if}
	</div>
</div>

<style>
	.connections {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	.sub-nav {
		width: 220px;
		flex-shrink: 0;
		border-right: 1px solid var(--rule-soft);
		background: var(--paper-2);
		padding: 24px 0;
		overflow-y: auto;
	}

	.sub-nav .kicker {
		padding: 0 20px 12px;
	}

	.sub-nav nav {
		display: flex;
		flex-direction: column;
	}

	.sub-link {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 20px;
		border-left: 3px solid transparent;
		color: var(--ink-2);
		text-decoration: none;
		transition: background 0.12s ease;
	}

	.sub-link:hover:not(.active) {
		background: rgba(26, 24, 20, 0.04);
	}

	.sub-link.active {
		background: var(--paper);
		border-left-color: var(--accent);
		color: var(--ink);
	}

	.sub-label {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.005em;
	}

	.sub-link.active .sub-label {
		color: var(--accent-2);
	}

	.sub-desc {
		font-size: 11px;
		color: var(--ink-3);
	}

	.content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
</style>
