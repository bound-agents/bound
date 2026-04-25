<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	children: Snippet;
	color?: string;
}

let { children, color = "var(--ink)" }: Props = $props();

const washColor = $derived(color.startsWith("var(") ? "rgba(26,24,20,0.05)" : `${color}11`);
</script>

<span
	class="ticket-tab"
	style="
		--tab-color: {color};
		--tab-wash: {washColor};
	"
>
	{@render children()}
</span>

<style>
	.ticket-tab {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--tab-color);
		border: 1px solid var(--tab-color);
		border-radius: 2px;
		background: repeating-linear-gradient(
			135deg,
			transparent 0 6px,
			var(--tab-wash) 6px 7px
		);
	}
</style>
