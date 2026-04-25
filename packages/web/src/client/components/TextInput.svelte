<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	value: string;
	onchange: (value: string) => void;
	placeholder?: string;
	icon?: Snippet;
	fullWidth?: boolean;
}

let { value, onchange, placeholder, icon, fullWidth = false }: Props = $props();
</script>

<label class="input-wrap" class:full={fullWidth}>
	{#if icon}
		<span class="icon">{@render icon()}</span>
	{/if}
	<input
		type="text"
		{value}
		{placeholder}
		oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value)}
	/>
</label>

<style>
	.input-wrap {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 0;
		min-width: 240px;
		color: var(--ink-3);
	}

	.input-wrap.full {
		display: flex;
		width: 100%;
		min-width: 0;
	}

	.icon {
		display: inline-flex;
		align-items: center;
		color: var(--ink-3);
	}

	input {
		border: none;
		outline: none;
		background: transparent;
		flex: 1;
		min-width: 0;
		font-family: var(--font-display);
		font-size: 13px;
		color: var(--ink);
	}

	input::placeholder {
		color: var(--ink-4);
	}
</style>
