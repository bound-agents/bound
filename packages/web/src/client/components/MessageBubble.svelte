<script lang="ts">
import { renderMarkdown } from "../lib/markdown";
import { getLineColor } from "../lib/metro-lines";
import { MetroCard } from "./shared";

const {
	role,
	content,
	toolName = null,
	modelId = null,
	exitCode = null,
	threadColor = 0,
} = $props<{
	role: "user" | "assistant" | "tool_call" | "tool_result" | "alert" | "system";
	content: string;
	toolName?: string | null;
	modelId?: string | null;
	exitCode?: number | null;
	threadColor?: number;
}>();

const isError = $derived(role === "tool_result" && exitCode !== null && exitCode !== 0);

// Compute accent color based on role
const accentColor = $derived.by(() => {
	if (role === "user") {
		return "var(--line-7)"; // Emerald
	}
	if (role === "assistant") {
		return getLineColor(threadColor);
	}
	return undefined;
});

let rendered = $state("");

$effect(() => {
	if (role === "assistant" || role === "user") {
		renderMarkdown(content)
			.then((html) => {
				rendered = html;
			})
			.catch((err: unknown) => {
				console.error("[markdown] renderMarkdown failed:", err);
			});
	} else {
		rendered = "";
	}
});
</script>

{#if role === "tool_result"}
	<div class="message-bubble tool_result" class:tool_error={isError}>
		<div class="role-badge" class:result-badge={!isError} class:error-badge={isError}>
			{isError ? "error" : "result"}
		</div>
		<pre class="tool-output" class:tool-output-error={isError}>{content}</pre>
	</div>
{:else if role === "alert"}
	<div class="message-bubble alert">
		<div class="role-badge alert-badge">! alert</div>
		<div class="content">{content}</div>
	</div>
{:else if role === "system"}
	<div class="message-bubble system">
		<div class="content system-text">{content}</div>
	</div>
{:else}
	<MetroCard {accentColor}>
		<div class="message-content {role}">
			<div class="role-badge">
				{role}
			</div>
			{#if rendered}
				<div class="content md-content">{@html rendered}</div>
			{:else}
				<div class="content">{content}</div>
			{/if}
			{#if role === "assistant" && modelId}
				<div class="metadata">
					<span class="model-pill">{modelId}</span>
				</div>
			{/if}
		</div>
	</MetroCard>
{/if}

<style>
	.message-bubble {
		padding: 10px 14px;
		margin: 6px 0;
		border-radius: 8px;
		background: var(--bg-secondary);
		border-left: 2px solid var(--bg-surface);
		transition: background 0.15s ease;
		line-height: 1.55;
	}

	.message-content {
		padding: 10px 14px;
		line-height: 1.55;
	}

	/* User messages */
	.message-content.user {
		/* Tint applied via MetroCard accent border */
	}

	/* Assistant messages */
	.message-content.assistant {
		/* Tint applied via MetroCard accent border */
	}

	/* Tool results: Chiyoda green accent */
	.tool_result {
		background: rgba(0, 153, 68, 0.06);
		border-left-color: var(--line-4);
	}

	/* Failed tool results: disruption red accent */
	.tool_error {
		background: rgba(255, 23, 68, 0.06);
		border-left-color: var(--alert-disruption);
	}

	/* Alerts: disruption red */
	.alert {
		background: rgba(255, 23, 68, 0.08);
		border-left-color: var(--alert-disruption);
		box-shadow: 0 0 12px rgba(255, 23, 68, 0.08);
	}

	/* System: subtle, centered */
	.system {
		background: transparent;
		border-left: none;
		text-align: center;
		padding: 6px 18px;
	}

	.role-badge {
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 6px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.metadata {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	.model-pill {
		display: inline-block;
		padding: 2px 8px;
		background: rgba(243, 151, 0, 0.12);
		border: 1px solid rgba(243, 151, 0, 0.25);
		border-radius: 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--line-0);
		text-transform: none;
		letter-spacing: 0;
	}

	.result-badge {
		color: var(--line-4);
	}

	.error-badge {
		color: var(--alert-disruption);
		font-weight: 700;
	}

	.alert-badge {
		color: var(--alert-warning);
		font-weight: 700;
	}

	.content {
		word-wrap: break-word;
		font-size: var(--text-base);
		color: var(--text-primary);
	}

	.system-text {
		font-style: italic;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.tool-output {
		margin: 6px 0 0;
		padding: 12px;
		background: rgba(0, 153, 68, 0.05);
		border: 1px solid rgba(0, 153, 68, 0.12);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--status-active);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tool-output-error {
		background: rgba(255, 23, 68, 0.05);
		border-color: rgba(255, 23, 68, 0.2);
		color: var(--alert-disruption);
	}

	/* -----------------------------------------------------------------------
	   Markdown content — .md-content
	   :global() is required because marked generates HTML outside Svelte's
	   scoped class system. All selectors are prefixed with .md-content to
	   avoid leaking styles to non-markdown elements.
	   ----------------------------------------------------------------------- */

	:global(.md-content > *:first-child) {
		margin-top: 0;
	}

	/* Headings — scaled down from browser defaults; messages are not documents */
	:global(.md-content h1) {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0.75em 0 0.4em;
		line-height: 1.3;
	}

	:global(.md-content h2) {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0.65em 0 0.35em;
		line-height: 1.3;
	}

	:global(.md-content h3) {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0.6em 0 0.3em;
	}

	/* Paragraphs */
	:global(.md-content p) {
		margin: 0.5em 0;
		line-height: 1.6;
	}

	/* Lists */
	:global(.md-content ul),
	:global(.md-content ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}

	:global(.md-content li) {
		margin: 0.2em 0;
		line-height: 1.55;
	}

	/* Inline code — IBM Plex Mono, distinct background, 3px radius */
	:global(.md-content code:not(pre > code)) {
		font-family: var(--font-mono);
		font-size: 0.875em;
		background: var(--bg-surface);
		color: var(--text-primary);
		padding: 0.15em 0.4em;
		border-radius: 3px;
		border: 1px solid rgba(255, 255, 255, 0.06);
	}

	/* Shiki-highlighted fenced code blocks */
	:global(.md-content pre.shiki) {
		margin: 0.6em 0;
		padding: 12px 16px;
		border-radius: 6px;
		overflow-x: auto;
		line-height: 1.5;
		font-size: 0.875rem;
		font-family: var(--font-mono);
		/* Shiki sets background via inline style from the tokyo-night theme */
	}

	:global(.md-content pre.shiki code) {
		background: none;
		border: none;
		padding: 0;
		font-size: inherit;
	}

	/* Default fenced code blocks (no language — not Shiki-highlighted) */
	:global(.md-content pre:not(.shiki)) {
		margin: 0.6em 0;
		padding: 12px 16px;
		background: rgba(10, 10, 20, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 0.875rem;
		overflow-x: auto;
		line-height: 1.5;
		color: var(--text-primary);
	}

	:global(.md-content pre:not(.shiki) code) {
		background: none;
		border: none;
		padding: 0;
		font-size: inherit;
		color: inherit;
	}

	/* Blockquotes */
	:global(.md-content blockquote) {
		margin: 0.5em 0;
		padding: 0.3em 0 0.3em 1em;
		border-left: 3px solid rgba(255, 255, 255, 0.12);
		color: var(--text-secondary);
	}

	/* Horizontal rule */
	:global(.md-content hr) {
		border: none;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		margin: 0.8em 0;
	}

	/* Links */
	:global(.md-content a) {
		color: var(--line-3);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	:global(.md-content a:hover) {
		color: var(--line-0);
	}

	/* Tables — .table-wrap is injected by the custom table renderer in markdown.ts */
	:global(.md-content .table-wrap) {
		overflow-x: auto;
		margin: 0.6em 0;
		border-radius: 4px;
	}

	:global(.md-content table) {
		border-collapse: collapse;
		min-width: 100%;
		font-size: var(--text-sm);
	}

	:global(.md-content th) {
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-secondary);
		font-weight: 600;
		padding: 6px 12px;
		text-align: left;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}

	:global(.md-content td) {
		padding: 5px 12px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.04);
		color: var(--text-primary);
	}

	/* Thinking blocks — Hanzomon purple (--line-6) left border at 0.75 opacity */
	:global(.md-content .thinking-block) {
		border-left: 3px solid rgba(143, 118, 214, 0.75);
		padding: 0.3em 0 0.3em 0.75em;
		margin: 0.5em 0;
	}

	:global(.md-content .thinking-block > summary) {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		cursor: pointer;
		user-select: none;
		padding: 2px 0;
	}

	:global(.md-content .thinking-block > summary:hover) {
		color: var(--text-primary);
	}
</style>
