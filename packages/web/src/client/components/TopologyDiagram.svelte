<script lang="ts">
interface Host {
	site_id: string;
	host_name: string;
	version?: string | null;
	online_at?: string | null;
}

type Health = "healthy" | "degraded" | "unreachable" | "unknown";

interface Props {
	hosts: Host[];
	hub: { siteId: string; hostName: string } | null;
	syncHealth: Map<string, Health>;
	localSiteId?: string;
}

let { hosts, hub, syncHealth, localSiteId }: Props = $props();

const VB_W = 1100;
const VB_H = 380;
const CX = VB_W / 2;
const CY = VB_H / 2 - 10;
const R = 150;

// Separate hub/peers. Hub goes in the center; peers orbit around.
const hubHost = $derived(hosts.find((h) => h.site_id === hub?.siteId) ?? null);
const peerHosts = $derived(hosts.filter((h) => h.site_id !== hub?.siteId));

const positions = $derived(
	peerHosts.map((h, i) => {
		const angle = (Math.PI * 2 * i) / Math.max(1, peerHosts.length) - Math.PI / 2;
		return {
			host: h,
			x: CX + Math.cos(angle) * R,
			y: CY + Math.sin(angle) * R * 0.85,
		};
	}),
);

function linkColor(health: Health): string {
	switch (health) {
		case "healthy":
			return "var(--ok)";
		case "degraded":
			return "var(--warn)";
		case "unreachable":
			return "var(--err)";
		default:
			return "var(--ink-4)";
	}
}

function isOnline(host: Host): boolean {
	if (host.site_id === localSiteId) return true;
	if (!host.online_at) return false;
	return Date.now() - new Date(host.online_at).getTime() < 5 * 60 * 1000;
}
</script>

<div class="topology">
	<div class="compass-bar">
		<div class="kicker">Cluster Topology</div>
		<div class="legend">
			<span class="leg-item">
				<span class="leg-sq" style="background: var(--ok)"></span>
				Healthy
			</span>
			<span class="leg-item">
				<span class="leg-sq" style="background: var(--err)"></span>
				Unreachable
			</span>
		</div>
	</div>

	<svg viewBox="0 0 {VB_W} {VB_H}" preserveAspectRatio="xMidYMid meet" class="topology-svg">
		<!-- Background compass rings -->
		<g opacity="0.2">
			<circle cx={CX} cy={CY} r="80" fill="none" stroke="var(--ink)" stroke-width="0.5" stroke-dasharray="2 4" />
			<circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--ink)" stroke-width="0.5" stroke-dasharray="2 4" />
			<circle cx={CX} cy={CY} r="200" fill="none" stroke="var(--ink)" stroke-width="0.5" stroke-dasharray="2 4" />
		</g>

		<!-- Spokes + animated pulse dot for healthy edges -->
		{#each positions as { host, x, y } (host.site_id)}
			{@const health = syncHealth.get(host.site_id) ?? "unknown"}
			{@const col = linkColor(health)}
			<g>
				<line
					x1={CX}
					y1={CY}
					x2={x}
					y2={y}
					stroke={col}
					stroke-width="3"
					stroke-linecap="round"
					stroke-dasharray={health === "unreachable" ? "6 6" : "0"}
				/>
				{#if health === "healthy" && isOnline(host)}
					<circle r="3" fill={col}>
						<animateMotion dur="2.5s" repeatCount="indefinite" path="M{CX} {CY} L{x} {y}" />
					</circle>
				{/if}
			</g>
		{/each}

		<!-- Hub in center -->
		{#if hubHost}
			<g transform="translate({CX} {CY})">
				<circle r="44" fill="var(--paper-2)" stroke="var(--ink)" stroke-width="2" />
				<circle r="36" fill="var(--ink)" />
				<text
					text-anchor="middle"
					y="-4"
					fill="var(--paper)"
					font-family="var(--font-mono)"
					font-size="9"
					letter-spacing="0.24em"
				>HUB</text>
				<text
					text-anchor="middle"
					y="12"
					fill="var(--paper)"
					font-family="var(--font-display)"
					font-size="13"
					font-weight="600"
				>{hubHost.host_name}</text>
				{#if hubHost.version}
					<text
						text-anchor="middle"
						y="26"
						fill="rgba(255,255,255,0.55)"
						font-family="var(--font-mono)"
						font-size="9"
					>{hubHost.version}</text>
				{/if}
			</g>
		{/if}

		<!-- Peers -->
		{#each positions as { host, x, y } (host.site_id)}
			{@const health = syncHealth.get(host.site_id) ?? "unknown"}
			{@const online = isOnline(host)}
			<g transform="translate({x} {y})">
				<circle r="30" fill="var(--paper)" stroke={linkColor(health)} stroke-width="2" />
				<circle r="10" fill={online ? linkColor(health) : "var(--rule-soft)"} />
				<text
					text-anchor="middle"
					y="46"
					fill="var(--ink)"
					font-family="var(--font-display)"
					font-size="12"
					font-weight="600"
				>{host.host_name}</text>
				<text
					text-anchor="middle"
					y="60"
					fill="var(--ink-3)"
					font-family="var(--font-mono)"
					font-size="9.5"
					letter-spacing="0.12em"
				>{online ? "ONLINE" : "OFFLINE"}</text>
			</g>
		{/each}
	</svg>
</div>

<style>
	.topology {
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		padding: 18px 24px 24px;
		position: relative;
		overflow: hidden;
	}

	.compass-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
		padding-bottom: 10px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.legend {
		display: flex;
		gap: 16px;
		align-items: center;
	}

	.leg-item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--ink-3);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.leg-sq {
		width: 9px;
		height: 9px;
	}

	.topology-svg {
		display: block;
		width: 100%;
		height: 340px;
	}
</style>
