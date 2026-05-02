<script lang="ts">
import { rankDepartures } from "../lib/departure-sort";
import LineBadge from "./LineBadge.svelte";

interface EnhancedTask {
	id: string;
	type: string;
	displayName: string;
	status: string;
	schedule?: string | null;
	hostName?: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
}

interface Props {
	tasks: EnhancedTask[];
}

let { tasks }: Props = $props();

// Task type to line index mapping (paper-signage palette)
const TYPE_TO_LINE: Record<string, number> = {
	cron: 0, // Ginza amber
	heartbeat: 7, // Namboku teal
	deferred: 3, // Tozai blue
	event: 6, // Hanzomon violet
};

const STATUS_SYMBOL: Record<string, string> = {
	running: "ON TIME",
	claimed: "APPROACH",
	pending: "SCHEDULED",
	failed: "DELAYED",
	completed: "ARRIVED",
	cancelled: "CANCELLED",
};

const ranked = $derived(rankDepartures(tasks));

function statusColor(s: string): string {
	if (s === "failed") return "#FF6B5B";
	if (s === "running" || s === "claimed") return "#8FE0A0";
	return "#F5AA3B";
}

function countdown(iso: string | null): string {
	if (!iso) return "—";
	const diff = new Date(iso).getTime() - Date.now();
	if (Math.abs(diff) < 5_000) return "T+00s";
	if (diff > 0) {
		const s = Math.floor(diff / 1000);
		if (s < 60) return `T-${String(s).padStart(2, "0")}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `T-${String(m).padStart(2, "0")}m`;
		return `T-${String(Math.floor(m / 60)).padStart(2, "0")}h`;
	}
	const s = Math.floor(-diff / 1000);
	if (s < 60) return `T+${String(s).padStart(2, "0")}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `T+${String(m).padStart(2, "0")}m`;
	return `T+${String(Math.floor(m / 60)).padStart(2, "0")}h`;
}

function typeLetter(type: string): string {
	return type[0]?.toUpperCase() ?? "T";
}
</script>

<div class="board">
	<div class="chrome"></div>

	<div class="header">
		<div class="board-title">DEPARTURES</div>
		<div class="board-meta">
			<span>AUTO-REFRESH · 5s</span>
			<span class="pulse-dot"></span>
		</div>
	</div>

	<div class="columns">
		<div>DEPART</div>
		<div>LINE</div>
		<div>DESTINATION</div>
		<div>SCHEDULE</div>
		<div>HOST</div>
		<div class="right">STATUS</div>
	</div>

	{#each ranked as t, i (t.id)}
		<div class="row" class:not-last={i < ranked.length - 1}>
			<div class="depart mono">{countdown(t.next_run_at)}</div>
			<div>
				<LineBadge lineIndex={TYPE_TO_LINE[t.type] ?? 0} size="compact" label={typeLetter(t.type)} />
			</div>
			<div class="destination">{t.displayName}</div>
			<div class="schedule">{t.schedule ?? "—"}</div>
			<div class="host">{t.hostName ?? "—"}</div>
			<div class="status right" style="color: {statusColor(t.status)}">
				{STATUS_SYMBOL[t.status] ?? t.status.toUpperCase()}
			</div>
		</div>
	{/each}

	{#if ranked.length === 0}
		<div class="empty">No tasks scheduled.</div>
	{/if}

	<div class="tape-wrap">
		<div class="tape">
			{#each Array(4) as _}
				<span class="tape-segment">
					· SERVICE ANNOUNCEMENT · TASKS LIVE · NEXT SHED WINDOW 03:00 JST · CROSS-HOST LATENCY NORMAL · BOUND SYSTEM
				</span>
			{/each}
		</div>
	</div>
</div>

<style>
	.board {
		position: relative;
		background: #171411;
		color: #f5e9c8;
		padding: 22px 24px 18px;
		box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.4);
		border: 1px solid #0c0a08;
		margin-bottom: 24px;
	}

	.chrome {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 4px;
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent);
	}

	.header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		border-bottom: 1px solid rgba(245, 233, 200, 0.2);
		padding-bottom: 10px;
		margin-bottom: 14px;
	}

	.board-title {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.32em;
		color: #f5aa3b;
	}

	.board-meta {
		display: flex;
		align-items: center;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: rgba(245, 233, 200, 0.5);
		letter-spacing: 0.18em;
	}

	.pulse-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #f5aa3b;
		animation: board-pulse 1.2s ease-in-out infinite;
	}

	@keyframes board-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.25; }
	}

	.columns {
		display: grid;
		grid-template-columns: 80px 60px 1fr 140px 100px 130px;
		gap: 14px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.22em;
		color: rgba(245, 233, 200, 0.45);
		margin-bottom: 10px;
	}

	.right {
		text-align: right;
	}

	.row {
		display: grid;
		grid-template-columns: 80px 60px 1fr 140px 100px 130px;
		gap: 14px;
		padding: 9px 0;
		font-family: var(--font-mono);
		font-size: 15px;
		color: #f5e9c8;
		align-items: center;
	}

	.row.not-last {
		border-bottom: 1px dashed rgba(245, 233, 200, 0.12);
	}

	.depart {
		font-size: 18px;
		font-weight: 500;
		color: #f5aa3b;
		font-variant-numeric: tabular-nums;
	}

	.destination {
		font-size: 13px;
		letter-spacing: 0.02em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.schedule {
		font-size: 12px;
		color: rgba(245, 233, 200, 0.7);
	}

	.host {
		font-size: 12px;
		color: rgba(245, 233, 200, 0.55);
	}

	.status {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
	}

	.empty {
		padding: 24px 0;
		font-family: var(--font-mono);
		font-size: 12px;
		color: rgba(245, 233, 200, 0.4);
		letter-spacing: 0.12em;
		text-align: center;
	}

	.tape-wrap {
		overflow: hidden;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid rgba(245, 233, 200, 0.2);
	}

	.tape {
		display: inline-flex;
		white-space: nowrap;
		animation: tape-scroll 60s linear infinite;
	}

	.tape-segment {
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.22em;
		color: rgba(245, 233, 200, 0.5);
	}

	@keyframes tape-scroll {
		from { transform: translateX(0); }
		to { transform: translateX(-50%); }
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse-dot,
		.tape {
			animation: none;
		}
	}
</style>
