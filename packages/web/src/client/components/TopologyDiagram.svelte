<script lang="ts">
import { getLineColor } from "../lib/metro-lines";

interface Host {
	site_id: string;
	host_name: string;
}

interface Props {
	hosts: Host[];
	hub: { siteId: string; hostName: string } | null;
	syncHealth: Map<string, "healthy" | "degraded" | "unreachable" | "unknown">;
}

let { hosts, hub, syncHealth }: Props = $props();

const SPOKE_COUNT = hosts.length;
const HUB_CX = 150;
const HUB_CY = 75;
const SPOKE_Y = 130;

const viewBoxWidth = $derived(Math.max(300, Math.min(600, 300 + SPOKE_COUNT * 40)));
const viewBoxHeight = 175;

// Calculate spoke positions across horizontal line
const spokePositions = $derived(
	hosts.map((_, idx) => {
		const totalWidth = viewBoxWidth - 60; // Leave 30px margin on each side
		const startX = 30;
		if (SPOKE_COUNT === 1) {
			return startX + totalWidth / 2;
		}
		return startX + (totalWidth / (SPOKE_COUNT - 1)) * idx;
	}),
);

function getHealthColor(hostSiteId: string): string {
	const health = syncHealth.get(hostSiteId);
	switch (health) {
		case "healthy":
			return "var(--status-active)";
		case "degraded":
			return "var(--alert-warning)";
		case "unreachable":
			return "var(--alert-disruption)";
		default:
			return "var(--text-muted)";
	}
}
</script>

<svg {viewBoxWidth} {viewBoxHeight} viewBox="0 0 {viewBoxWidth} {viewBoxHeight}" class="topology-diagram">
	<!-- Connection lines from hub to spokes -->
	{#each hosts as host, idx}
		{@const spokeX = spokePositions[idx]}
		{@const lineColor = getHealthColor(host.site_id)}
		<line x1={HUB_CX} y1={HUB_CY} x2={spokeX} y2={SPOKE_Y} stroke={lineColor} stroke-width="2" opacity="0.6" />
	{/each}

	<!-- Hub node (double circle) -->
	{#if hub}
		<circle cx={HUB_CX} cy={HUB_CY} r="20" fill="white" stroke="var(--text-primary)" stroke-width="1.5" />
		<circle cx={HUB_CX} cy={HUB_CY} r="14" fill="none" stroke="var(--text-primary)" stroke-width="1" />
		<text x={HUB_CX} y={HUB_CY} font-size="10" font-weight="700" fill="var(--text-primary)" text-anchor="middle" dominant-baseline="central" font-family="var(--font-display)">
			H
		</text>
	{/if}

	<!-- Spoke nodes -->
	{#each hosts as host, idx}
		{@const spokeX = spokePositions[idx]}
		{@const color = getLineColor(idx)}
		{@const shortName = host.host_name.length > 8 ? host.host_name.slice(0, 6) + "…" : host.host_name}
		<circle cx={spokeX} cy={SPOKE_Y} r="12" fill={color} />
		<text
			x={spokeX}
			y={SPOKE_Y + 24}
			font-size="8"
			font-weight="600"
			fill="var(--text-secondary)"
			text-anchor="middle"
			font-family="var(--font-mono)"
		>
			{shortName}
		</text>
	{/each}
</svg>

<style>
	.topology-diagram {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 16px 0;
	}
</style>
