<script lang="ts">
	type StatusType =
		| "active"
		| "running"
		| "pending"
		| "failed"
		| "idle"
		| "cancelled"
		| "delayed"
		| "overdue"
		| "healthy"
		| "degraded"
		| "unreachable";

	interface Props {
		status: StatusType;
		label?: string;
		animate?: boolean;
	}

	let { status, label, animate = true }: Props = $props();

	const STATUS_COLORS: Record<StatusType, string> = {
		active: "var(--status-active)",
		running: "var(--status-active)",
		healthy: "var(--status-active)",
		pending: "var(--alert-warning)",
		delayed: "var(--alert-warning)",
		failed: "var(--alert-disruption)",
		overdue: "var(--alert-disruption)",
		unreachable: "var(--alert-disruption)",
		idle: "var(--text-muted)",
		cancelled: "var(--text-muted)",
		degraded: "var(--text-muted)",
	};

	const color = STATUS_COLORS[status];
	const displayLabel = label ?? status.toUpperCase();
	const shouldAnimate = animate && (status === "active" || status === "running");
</script>

<span class="status-chip" class:animate={shouldAnimate} style="--dot-color: {color}">
	<span class="dot"></span>
	<span class="label">{displayLabel}</span>
</span>

<style>
	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background-color: var(--dot-color);
		flex-shrink: 0;
	}

	.label {
		font-size: var(--text-xs);
		color: var(--text-primary);
		letter-spacing: 0.04em;
		font-weight: 500;
	}

	.status-chip.animate .dot {
		animation: badge-pulse 2s ease-in-out infinite;
	}

	@keyframes badge-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.6;
		}
	}
</style>
