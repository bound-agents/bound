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
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
		padding: 12px;
		transition: background 0.15s ease;
	}

	.metro-card.accented {
		border-left: 3px solid var(--accent-color);
	}

	.metro-card.interactive {
		cursor: pointer;
	}

	.metro-card.interactive:hover {
		background: rgba(42, 48, 68, 0.3);
	}
</style>
