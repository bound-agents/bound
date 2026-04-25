<script lang="ts">
type StatusType =
	| "active"
	| "running"
	| "claimed"
	| "pending"
	| "idle"
	| "failed"
	| "cancelled"
	| "completed"
	| "delayed"
	| "overdue"
	| "proposed"
	| "approved"
	| "dismissed"
	| "deferred"
	| "applied"
	| "healthy"
	| "degraded"
	| "unreachable"
	| "online"
	| "offline";

interface Props {
	status: StatusType;
	label?: string;
	animate?: boolean;
	size?: "sm" | "lg";
}

let { status, label, animate = true, size = "sm" }: Props = $props();

const STATUS_MAP: Record<StatusType, { label: string; color: string; pulse: boolean }> = {
	active: { label: "On duty", color: "var(--ok)", pulse: true },
	running: { label: "Running", color: "var(--ok)", pulse: true },
	claimed: { label: "Claimed", color: "var(--line-T)", pulse: true },
	pending: { label: "Scheduled", color: "var(--ink-3)", pulse: false },
	idle: { label: "Idle", color: "var(--idle)", pulse: false },
	failed: { label: "Failed", color: "var(--err)", pulse: false },
	cancelled: { label: "Cancelled", color: "var(--idle)", pulse: false },
	completed: { label: "Completed", color: "var(--ink-3)", pulse: false },
	delayed: { label: "Delayed", color: "var(--warn)", pulse: true },
	overdue: { label: "Overdue", color: "var(--err)", pulse: true },
	proposed: { label: "Proposed", color: "var(--warn)", pulse: true },
	approved: { label: "Approved", color: "var(--ok)", pulse: false },
	dismissed: { label: "Dismissed", color: "var(--idle)", pulse: false },
	deferred: { label: "Deferred", color: "var(--line-T)", pulse: false },
	applied: { label: "Applied", color: "var(--line-Z)", pulse: false },
	healthy: { label: "Healthy", color: "var(--ok)", pulse: false },
	degraded: { label: "Degraded", color: "var(--warn)", pulse: false },
	unreachable: { label: "Unreachable", color: "var(--err)", pulse: false },
	online: { label: "Online", color: "var(--ok)", pulse: true },
	offline: { label: "Offline", color: "var(--err)", pulse: false },
};

const cfg = $derived(STATUS_MAP[status] ?? { label: status, color: "var(--idle)", pulse: false });
const displayLabel = $derived(label ?? cfg.label);
const shouldAnimate = $derived(animate && cfg.pulse);
const dot = $derived(size === "lg" ? 8 : 7);
</script>

<span class="status-chip" class:animate={shouldAnimate} style="--dot-color: {cfg.color}; --dot-size: {dot}px">
	<span class="dot"></span>
	<span class="label">{displayLabel}</span>
</span>

<style>
	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-display);
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--ink-2);
		white-space: nowrap;
	}

	.dot {
		display: inline-block;
		width: var(--dot-size);
		height: var(--dot-size);
		background: var(--dot-color);
		flex-shrink: 0;
	}

	.status-chip.animate .dot {
		animation: chip-pulse 1.6s ease-in-out infinite;
	}

	@keyframes chip-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.25; }
	}

	@media (prefers-reduced-motion: reduce) {
		.status-chip.animate .dot { animation: none; }
	}
</style>
