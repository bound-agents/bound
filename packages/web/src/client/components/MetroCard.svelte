<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	accentColor?: string;
	interactive?: boolean;
	children: Snippet;
}

let { accentColor, interactive = false, children }: Props = $props();
</script>

<div class="metro-card" class:interactive class:accented={!!accentColor} style={accentColor ? `--accent-color: ${accentColor}` : ""}>
	{@render children()}
</div>

<style>
	.metro-card {
		position: relative;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		padding: 12px;
		transition: background 0.15s ease;
	}

	/* Ticket stripe — fixed-width colored tab at the top edge.
	   --stripe-width can be overridden by parent context (e.g. compact cards). */
	.metro-card.accented::after {
		content: "";
		position: absolute;
		top: 0;
		left: 12px;
		width: var(--stripe-width, 32px);
		height: 2px;
		background: var(--accent-color);
		border-radius: 0 0 1px 1px;
		transition: width 0.2s ease;
	}

	.metro-card.interactive {
		cursor: pointer;
	}

	.metro-card.interactive:hover {
		background: rgba(42, 48, 68, 0.3);
	}

	.metro-card.interactive.accented:hover::after {
		width: calc(var(--stripe-width, 32px) + 16px);
	}
</style>
