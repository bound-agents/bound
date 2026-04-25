<script lang="ts">
import type { Snippet } from "svelte";

type Variant = "default" | "primary" | "accent" | "ghost" | "danger";

interface Props {
	children: Snippet;
	onclick?: (e: MouseEvent) => void;
	variant?: Variant;
	disabled?: boolean;
	title?: string;
	size?: "sm" | "md";
	type?: "button" | "submit";
}

let {
	children,
	onclick,
	variant = "default",
	disabled = false,
	title,
	size = "md",
	type = "button",
}: Props = $props();

const pad = $derived(size === "sm" ? "4px 10px" : "7px 14px");
const fs = $derived(size === "sm" ? 12 : 13);

const VARIANTS: Record<Variant, { bg: string; fg: string; border: string }> = {
	default: { bg: "transparent", fg: "var(--ink)", border: "var(--ink)" },
	primary: { bg: "var(--ink)", fg: "var(--paper)", border: "var(--ink)" },
	accent: { bg: "var(--accent)", fg: "#fff", border: "var(--accent)" },
	ghost: {
		bg: "transparent",
		fg: "var(--ink-2)",
		border: "var(--rule-soft)",
	},
	danger: { bg: "transparent", fg: "var(--err)", border: "var(--err)" },
};

const styles = $derived(VARIANTS[variant]);
</script>

<button
	{type}
	{onclick}
	{disabled}
	{title}
	class="btn"
	style="
		background: {styles.bg};
		color: {styles.fg};
		border: 1px solid {styles.border};
		padding: {pad};
		font-size: {fs}px;
		cursor: {disabled ? 'not-allowed' : 'pointer'};
		opacity: {disabled ? 0.4 : 1};
	"
>
	{@render children()}
</button>

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: none;
		border-radius: 0;
		transition:
			background 0.12s ease,
			color 0.12s ease;
	}
</style>
