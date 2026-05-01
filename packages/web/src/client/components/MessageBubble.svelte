<script lang="ts">
import { renderMarkdown, splitOnThinkingBlocks } from "../lib/markdown";
import { getLineColor } from "../lib/metro-lines";
import ReasoningBlock from "./ReasoningBlock.svelte";

interface Props {
	role: "user" | "assistant" | "tool_call" | "tool_result" | "alert" | "system";
	content: string;
	toolName?: string | null;
	modelId?: string | null;
	exitCode?: number | null;
	threadColor?: number;
}

const {
	role,
	content,
	toolName: _toolName = null,
	modelId = null,
	exitCode = null,
	threadColor = 0,
}: Props = $props();

const isError = $derived(role === "tool_result" && exitCode !== null && exitCode !== 0);

const lineColor = $derived(getLineColor(threadColor));

const roleLabel = $derived.by(() => {
	switch (role) {
		case "user":
			return "You";
		case "assistant":
			return "Agent";
		case "alert":
			return "System";
		case "system":
			return "";
		case "tool_result":
			return isError ? "Error" : "Result";
		case "tool_call":
			return "Tool";
		default:
			return role;
	}
});

// Parse content: if the DB row is a JSON-serialized ContentBlock[]
// containing only text blocks, split into separate display blocks.
const textBlocks = $derived.by((): string[] => {
	if (role !== "user" && role !== "assistant") return [content];
	if (!content.startsWith("[")) return [content];
	try {
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed) || parsed.length === 0) return [content];
		if (parsed.every((b: { type?: string }) => b?.type === "text")) {
			return parsed.map((b: { text?: string }) => b.text ?? "").filter(Boolean);
		}
	} catch {
		// Not JSON — plain text
	}
	return [content];
});

// For assistant messages we split <thinking>...</thinking> sections out of
// the content and render them as a ReasoningBlock disclosure above the
// prose. Legacy compatibility — modern agent runs store reasoning as a
// structured ContentBlock on the tool_call message (ToolCallCard).
const segments = $derived.by(() => {
	if (role !== "assistant") return null;
	return splitOnThinkingBlocks(textBlocks[0] ?? "");
});

const thinkingText = $derived.by(() => {
	if (!segments) return "";
	return segments
		.filter((s) => s.kind === "thinking")
		.map((s) => s.text)
		.join("\n\n")
		.trim();
});

const proseText = $derived.by(() => {
	if (!segments) return textBlocks[0] ?? "";
	return segments
		.filter((s) => s.kind === "text")
		.map((s) => s.text)
		.join("")
		.trim();
});

let renderedBlocks = $state<string[]>([]);

$effect(() => {
	if (role !== "assistant" && role !== "user") {
		renderedBlocks = [];
		return;
	}
	const sources = role === "assistant" ? [proseText, ...textBlocks.slice(1)] : textBlocks;
	Promise.all(
		sources.map((src) => (src ? renderMarkdown(src).catch(() => "") : Promise.resolve(""))),
	).then((results) => {
		renderedBlocks = results;
	});
});
</script>

{#if role === "tool_result"}
	<div class="message tool-result" class:tool-error={isError} style="--line-color: {lineColor}">
		<div class="role-row">
			<span class="role role-result" class:role-error={isError}>
				{roleLabel}
			</span>
		</div>
		<pre class="tool-output" class:tool-output-error={isError}>{content}</pre>
	</div>
{:else if role === "alert"}
	<div class="message alert" style="--line-color: {lineColor}">
		<div class="role-row">
			<span class="role role-alert">Advisory posted</span>
		</div>
		<div class="alert-body">{content}</div>
	</div>
{:else if role === "system"}
	<div class="message system">
		<div class="system-text">{content}</div>
	</div>
{:else}
	<div class="message {role}" style="--line-color: {lineColor}">
		<div class="role-row">
			<span class="role">{roleLabel}</span>
			{#if role === "assistant" && modelId}
				<span class="model mono">{modelId}</span>
			{/if}
		</div>
		{#if role === "assistant" && thinkingText}
			<ReasoningBlock text={thinkingText} {lineColor} />
		{/if}
		{#each textBlocks as block, i}
			{#if renderedBlocks[i]}
				<div class="content md-content">{@html renderedBlocks[i]}</div>
			{:else}
				<div class="content">{block}</div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.message {
		position: relative;
		padding: 4px 0 16px;
		line-height: 1.55;
		margin: 0;
	}

	.role-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 6px;
	}

	.role {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-2);
	}

	.message.user .role {
		color: var(--ink);
	}

	.role-alert {
		color: var(--accent);
	}

	.role-result {
		color: var(--ok);
	}

	.role-error {
		color: var(--err);
	}

	.model {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.04em;
	}

	.content {
		font-size: 14.5px;
		line-height: 1.65;
		color: var(--ink);
		font-family: var(--font-display);
		font-weight: 400;
		word-wrap: break-word;
	}

	.system {
		padding: 10px 16px;
		background: var(--paper-2);
		border-left: 3px solid var(--rule-soft);
		font-style: italic;
		color: var(--ink-3);
		font-size: 13px;
	}

	.alert {
		padding: 12px 14px;
		background: var(--accent-wash);
		border: 1px solid var(--accent);
		border-left: 3px solid var(--accent);
	}

	.alert-body {
		font-size: 13.5px;
		color: var(--ink);
		line-height: 1.55;
	}

	.tool-result {
		padding: 8px 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		border-left: 3px solid var(--line-color);
	}

	.tool-error {
		border-left-color: var(--err);
		background: rgba(178, 34, 34, 0.06);
	}

	.tool-output {
		margin: 6px 0 0;
		padding: 8px 10px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--ink-2);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tool-output-error {
		color: var(--err);
		border-color: var(--err);
	}

	/* ---- Markdown rendering ---- */
	:global(.md-content > *:first-child) { margin-top: 0; }

	:global(.md-content h1) {
		font-size: 1.3rem;
		font-weight: 700;
		color: var(--ink);
		margin: 0.75em 0 0.4em;
		line-height: 1.25;
		letter-spacing: -0.015em;
	}

	:global(.md-content h2) {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--ink);
		margin: 0.65em 0 0.35em;
		line-height: 1.3;
		letter-spacing: -0.01em;
	}

	:global(.md-content h3) {
		font-size: 1rem;
		font-weight: 600;
		color: var(--ink);
		margin: 0.6em 0 0.3em;
	}

	:global(.md-content p) {
		margin: 0.5em 0;
		line-height: 1.65;
	}

	:global(.md-content ul),
	:global(.md-content ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}

	:global(.md-content li) {
		margin: 0.2em 0;
		line-height: 1.55;
	}

	:global(.md-content strong) {
		font-weight: 600;
	}

	:global(.md-content em) {
		font-style: italic;
		font-family: var(--font-serif);
	}

	:global(.md-content code:not(pre > code)) {
		font-family: var(--font-mono);
		font-size: 0.88em;
		background: var(--paper-3);
		color: var(--ink);
		padding: 1px 5px;
		border: 1px solid var(--rule-faint);
	}

	:global(.md-content pre.shiki),
	:global(.md-content pre:not(.shiki)) {
		margin: 0.6em 0;
		padding: 12px 14px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		border-left: 3px solid var(--accent);
		overflow-x: auto;
		line-height: 1.55;
		font-size: 12px;
		font-family: var(--font-mono);
	}

	:global(.md-content pre code) {
		background: none;
		border: none;
		padding: 0;
		font-size: inherit;
	}

	:global(.md-content blockquote) {
		margin: 0.5em 0;
		padding: 6px 14px;
		border-left: 3px solid var(--ink-4);
		color: var(--ink-2);
		font-family: var(--font-serif);
		font-style: italic;
	}

	:global(.md-content hr) {
		border: none;
		border-top: 1px solid var(--rule-soft);
		margin: 0.8em 0;
	}

	:global(.md-content a) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	:global(.md-content a:hover) {
		color: var(--ink);
	}

	:global(.md-content .table-wrap) {
		overflow-x: auto;
		margin: 0.6em 0;
		border: 1px solid var(--rule-soft);
	}

	:global(.md-content table) {
		border-collapse: collapse;
		min-width: 100%;
		font-size: 13px;
	}

	:global(.md-content th) {
		background: var(--paper-3);
		color: var(--ink);
		font-weight: 600;
		padding: 6px 10px;
		text-align: left;
		border-bottom: 1px solid var(--ink);
		letter-spacing: 0.04em;
	}

	:global(.md-content td) {
		padding: 6px 10px;
		border-bottom: 1px solid var(--rule-faint);
		color: var(--ink-2);
	}
</style>
