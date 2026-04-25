<script lang="ts">
import { Check, ChevronDown, ChevronUp, Cog, Wrench } from "lucide-svelte";
import { renderMarkdown } from "../lib/markdown";
import ReasoningBlock from "./ReasoningBlock.svelte";

// Renders a single tool_call message. The message's `content` field is a
// JSON-stringified array of ContentBlocks (see packages/llm/src/types.ts
// ContentBlock): typically [thinking?, text?, ...tool_use]. This component
// treats the persisted block order as the source of truth — no cross-message
// grouping, no scooping assistant-text blocks from adjacent messages.

interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
	redacted_data?: string;
}

interface TextBlock {
	type: "text";
	text: string;
}

type Block = ThinkingBlock | TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };

interface ToolResultMsg {
	content: string;
	exit_code?: number | null;
	tool_name?: string | null;
}

interface Props {
	content: string;
	resultsByToolUseId?: Record<string, ToolResultMsg>;
	lineColor?: string;
	modelId?: string | null;
}

const {
	content,
	resultsByToolUseId = {},
	lineColor = "var(--rule-soft)",
	modelId = null,
}: Props = $props();

// Parse ContentBlock[] defensively — a malformed JSON should degrade to
// showing the raw string rather than throwing.
interface Parsed {
	thinkingText: string;
	redactedThinking: boolean;
	inlineText: string;
	toolUses: ToolUseBlock[];
	raw: string | null;
}

function parseBlocks(raw: string): Parsed {
	try {
		const blocks = JSON.parse(raw) as Block[];
		if (!Array.isArray(blocks)) {
			return { thinkingText: "", redactedThinking: false, inlineText: "", toolUses: [], raw };
		}
		let thinkingText = "";
		let redactedThinking = false;
		let inlineText = "";
		const toolUses: ToolUseBlock[] = [];
		for (const block of blocks) {
			if (block.type === "thinking") {
				const tb = block as ThinkingBlock;
				if (tb.thinking) thinkingText += tb.thinking;
				if (tb.redacted_data) redactedThinking = true;
			} else if (block.type === "text") {
				const text = (block as TextBlock).text;
				if (text) inlineText += (inlineText ? "\n\n" : "") + text;
			} else if (block.type === "tool_use") {
				toolUses.push(block as ToolUseBlock);
			}
		}
		return { thinkingText, redactedThinking, inlineText, toolUses, raw: null };
	} catch {
		return { thinkingText: "", redactedThinking: false, inlineText: "", toolUses: [], raw };
	}
}

const parsed = $derived(parseBlocks(content));

let renderedText = $state("");

$effect(() => {
	const txt = parsed.inlineText;
	if (!txt) {
		renderedText = "";
		return;
	}
	renderMarkdown(txt)
		.then((html) => {
			renderedText = html;
		})
		.catch((err: unknown) => {
			console.error("[markdown] renderMarkdown failed:", err);
			renderedText = "";
		});
});

function formatInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	if (typeof input === "string") return input;
	return JSON.stringify(input, null, 2);
}

function previewInput(input: unknown): string {
	const str = formatInput(input).replace(/\s+/g, " ").trim();
	if (str.length <= 80) return str;
	return `${str.slice(0, 77)}…`;
}

let expandedTools = $state(new Set<string>());

function toggleTool(id: string): void {
	const next = new Set(expandedTools);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expandedTools = next;
}
</script>

<div class="tool-call-card" style="--line-color: {lineColor}">
	<div class="role-row">
		<span class="role">Agent</span>
		{#if modelId}
			<span class="model mono">{modelId}</span>
		{/if}
	</div>

	{#if parsed.thinkingText || parsed.redactedThinking}
		<ReasoningBlock
			text={parsed.thinkingText}
			redacted={parsed.redactedThinking && !parsed.thinkingText}
			{lineColor}
		/>
	{/if}

	{#if renderedText}
		<div class="inline-text md-content">{@html renderedText}</div>
	{:else if parsed.inlineText}
		<div class="inline-text">{parsed.inlineText}</div>
	{/if}

	{#if parsed.raw}
		<pre class="raw-fallback">{parsed.raw}</pre>
	{/if}

	{#if parsed.toolUses.length > 0}
		<div class="tool-list">
			{#each parsed.toolUses as tu (tu.id)}
				{@const result = resultsByToolUseId[tu.id]}
				{@const isErr = result && result.exit_code != null && result.exit_code !== 0}
				{@const expanded = expandedTools.has(tu.id)}
				<div class="tool-row" class:tool-row-expanded={expanded}>
					<button
						type="button"
						class="tool-row-header"
						onclick={() => toggleTool(tu.id)}
					>
						<span class="tr-icon"><Wrench size={12} /></span>
						<span class="tr-name">{tu.name}</span>
						{#if !expanded}
							<span class="tr-preview">{previewInput(tu.input)}</span>
						{/if}
						{#if result}
							<span class="tr-done" class:tr-error={isErr}><Check size={11} /></span>
						{/if}
						<span class="tr-toggle">
							{#if expanded}
								<ChevronUp size={11} />
							{:else}
								<ChevronDown size={11} />
							{/if}
						</span>
					</button>

					{#if expanded}
						<pre class="tr-input">{formatInput(tu.input)}</pre>
						{#if result}
							<div class="tr-divider"></div>
							<pre class="tr-output" class:tr-output-error={isErr}>{result.content}</pre>
						{:else}
							<div class="tr-pending">
								<Cog size={11} /> <span>Awaiting result…</span>
							</div>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.tool-call-card {
		position: relative;
		padding: 4px 0 16px;
		line-height: 1.55;
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

	.model {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.04em;
	}

	.inline-text {
		font-size: 14.5px;
		line-height: 1.65;
		color: var(--ink);
		font-family: var(--font-display);
		font-weight: 400;
		word-wrap: break-word;
		margin-bottom: 10px;
	}

	.raw-fallback {
		margin: 6px 0;
		padding: 8px 10px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-3);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.tool-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.tool-row {
		background: var(--paper-2);
		border: 1px solid var(--rule-faint);
		border-left: 3px solid var(--line-color);
		overflow: hidden;
	}

	.tool-row-expanded {
		border-color: var(--rule-soft);
	}

	.tool-row-header {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 11px;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		font: inherit;
		color: inherit;
	}

	.tool-row-header:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.tr-icon {
		color: var(--accent);
		display: flex;
		align-items: center;
		opacity: 0.85;
	}

	.tr-name {
		font-family: var(--font-mono);
		font-weight: 600;
		font-size: 11.5px;
		color: var(--accent);
		flex-shrink: 0;
	}

	.tr-preview {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-3);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tr-done {
		color: var(--ok);
		display: flex;
		align-items: center;
		margin-left: auto;
	}

	.tr-error {
		color: var(--err);
	}

	.tr-toggle {
		color: var(--ink-4);
		display: flex;
		align-items: center;
	}

	.tr-input {
		margin: 0;
		padding: 8px 11px;
		background: var(--paper);
		border-top: 1px solid var(--rule-faint);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-2);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tr-divider {
		height: 1px;
		background: var(--rule-faint);
	}

	.tr-output {
		margin: 0;
		padding: 8px 11px;
		background: var(--paper);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ok);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tr-output-error {
		background: rgba(178, 34, 34, 0.06);
		color: var(--err);
	}

	.tr-pending {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 11px;
		border-top: 1px solid var(--rule-faint);
		background: var(--paper);
		font-family: var(--font-display);
		font-size: 11.5px;
		color: var(--ink-3);
		font-style: italic;
	}
</style>
