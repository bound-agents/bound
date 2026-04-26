<script lang="ts">
// Collapsible disclosure widget for model reasoning/thinking content.
// Mirrors the ThinkingBlock pattern from the redesign spec: italic-serif
// label with a word count, left-border accent in the thread's line color.
// The expanded body renders the reasoning text as markdown so numbered
// lists, emphasis, inline code, and fenced blocks (which modern models
// routinely emit inside reasoning) display the same way they would in a
// normal assistant turn.

import { renderMarkdown } from "../lib/markdown";

interface Props {
	text: string;
	lineColor?: string;
	redacted?: boolean;
}

const { text, lineColor = "var(--rule-soft)", redacted = false }: Props = $props();

let open = $state(false);

const wordCount = $derived(text.trim().split(/\s+/).filter(Boolean).length);

let rendered = $state("");

$effect(() => {
	if (!text || redacted) {
		rendered = "";
		return;
	}
	renderMarkdown(text)
		.then((html) => {
			rendered = html;
		})
		.catch((err: unknown) => {
			console.error("[markdown] renderMarkdown failed:", err);
			rendered = "";
		});
});

function toggle(): void {
	open = !open;
}

function onKey(e: KeyboardEvent): void {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		toggle();
	}
}
</script>

<div class="reasoning-block">
	<button
		type="button"
		class="reasoning-toggle"
		onclick={toggle}
		onkeydown={onKey}
		aria-expanded={open}
	>
		<span class="reasoning-caret" class:reasoning-caret-open={open}>▸</span>
		<span class="reasoning-label">Reasoning</span>
		<span class="reasoning-meta">
			{#if redacted}
				· redacted
			{:else}
				· {wordCount} word{wordCount === 1 ? "" : "s"}
			{/if}
		</span>
	</button>

	{#if open}
		<div class="reasoning-body" style="border-left-color: {lineColor}">
			{#if redacted && !text}
				<em class="reasoning-redacted-note">
					Reasoning was redacted by the provider's safety filters.
				</em>
			{:else if rendered}
				<div class="reasoning-prose md-content">{@html rendered}</div>
			{:else}
				<div class="reasoning-prose">{text}</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.reasoning-block {
		margin: 0 0 10px;
	}

	.reasoning-toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px 4px 8px;
		background: transparent;
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		color: var(--ink-3);
		font-family: var(--font-display);
		font-size: 11.5px;
		font-weight: 500;
		letter-spacing: 0.02em;
	}

	.reasoning-toggle:hover {
		color: var(--ink);
		border-color: var(--ink-4);
	}

	.reasoning-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.reasoning-caret {
		display: inline-block;
		font-size: 10px;
		color: var(--ink-4);
		transition: transform 0.15s ease;
	}

	.reasoning-caret-open {
		transform: rotate(90deg);
	}

	.reasoning-label {
		font-family: var(--font-display);
		font-weight: 500;
		font-size: 11.5px;
		letter-spacing: 0.02em;
		color: var(--ink-2);
	}

	.reasoning-meta {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-4);
	}

	.reasoning-body {
		margin-top: 8px;
		padding: 12px 14px;
		background: var(--paper-2);
		border-left: 3px solid var(--rule-soft);
		font-size: 13.5px;
		line-height: 1.65;
		color: var(--ink-2);
	}

	/* Raw-text fallback: keep the italic-serif "reasoning" vibe when the
	 * markdown render hasn't landed yet (or for non-markdown prose). */
	.reasoning-prose:not(.md-content) {
		font-family: var(--font-serif);
		font-style: italic;
		white-space: pre-wrap;
		word-wrap: break-word;
	}

	/* Markdown-rendered path: let the shared .md-content styles govern
	 * structure (paragraphs, lists, code, tables). Only first-child margin
	 * needs a local reset so the body doesn't grow a double top gap. */
	.reasoning-prose.md-content :global(> *:first-child) {
		margin-top: 0;
	}

	.reasoning-redacted-note {
		color: var(--ink-3);
	}
</style>
