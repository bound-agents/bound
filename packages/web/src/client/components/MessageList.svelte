<script lang="ts">
import { onMount, tick } from "svelte";
import MessageBubble from "./MessageBubble.svelte";
import ToolCallGroup from "./ToolCallGroup.svelte";
import TurnIndicator from "./TurnIndicator.svelte";

interface Message {
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
	created_at?: string;
	id?: string;
	exit_code?: number | null;
}

interface ToolEntry {
	name: string;
	input: unknown;
	id: string;
	result?: string;
	exitCode?: number | null;
	timestamp?: string;
}

interface ToolCallItem {
	content: string;
	toolResults?: Message[];
	reasoning?: string[];
	earliest: string;
}

type ToolGroupSegment =
	| { kind: "tools"; entries: ToolEntry[] }
	| { kind: "reasoning"; text: string };

type DisplayItem =
	| { kind: "message"; msg: Message; earliest: string }
	| {
			kind: "toolGroup";
			segments: ToolGroupSegment[];
			earliest: string;
			timestamps: string[];
	  };

type Pass1Entry =
	| { kind: "message"; msg: Message; earliest: string }
	| { kind: "toolCall"; item: ToolCallItem };

interface TurnRange {
	from: string;
	to: string | null;
}

interface Props {
	messages: Message[];
	waiting?: boolean;
	emptyText?: string | null;
	turnRange?: TurnRange | null;
	threadColor?: number;
	lineColor?: string;
	isAgentActive?: boolean;
}

const {
	messages,
	waiting = false,
	emptyText = null,
	turnRange = null,
	threadColor = 0,
	lineColor = "#999",
	isAgentActive = false,
}: Props = $props();

// --- Auto-scroll logic ---
let scrollContainer = $state<HTMLDivElement | null>(null);
let prevMessageCount = 0;
let isAtBottom = true;
const BOTTOM_THRESHOLD = 80; // px of slack for "at bottom" detection

function checkIsAtBottom(): boolean {
	if (!scrollContainer) return true;
	const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
	return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
}

function scrollToBottom(smooth = true): void {
	if (!scrollContainer) return;
	// Wait for browser layout so scrollHeight reflects new content
	requestAnimationFrame(() => {
		if (!scrollContainer) return;
		scrollContainer.scrollTo({
			top: scrollContainer.scrollHeight,
			behavior: smooth ? "smooth" : "instant",
		});
	});
}

function handleScroll(): void {
	isAtBottom = checkIsAtBottom();
	updateScrollMetrics();
}

// Scroll to bottom on mount (case 2: opening a thread)
onMount(() => {
	tick().then(() => scrollToBottom());
});

// React to message changes
$effect(() => {
	const count = messages.length;
	if (count === prevMessageCount) return;

	const lastMsg = messages[count - 1];
	const isNewUserMessage = lastMsg?.role === "user";

	// Case 1: user sent a message → always scroll
	// Case 3: non-user message arrived while already at bottom → scroll
	if (isNewUserMessage || isAtBottom) {
		tick().then(() => scrollToBottom());
	}

	prevMessageCount = count;
});

// --- Scroll height + turn boundary tracking ---
let contentScrollHeight = $state(0);
let computedTurnOffsets = $state<number[]>([]);

function updateScrollMetrics(): void {
	if (!scrollContainer) return;
	contentScrollHeight = scrollContainer.scrollHeight;

	// Compute turn boundaries relative to scroll container content
	const offsets: number[] = [];
	let lastWasUser = false;
	const items = scrollContainer.querySelectorAll("[data-message-role]");
	for (const el of items) {
		const role = el.getAttribute("data-message-role");
		if (role === "user" && !lastWasUser) {
			// offsetTop relative to scroll container
			const offset = (el as HTMLElement).offsetTop;
			offsets.push(offset);
			lastWasUser = true;
		} else if (role === "assistant") {
			lastWasUser = false;
		}
	}
	computedTurnOffsets = offsets;
}

// Update metrics when messages change
$effect(() => {
	if (messages.length > 0) {
		tick().then(updateScrollMetrics);
	}
});

// --- Turn range highlighting + scroll ---
function tsInRange(ts: string, range: TurnRange): boolean {
	if (ts < range.from) return false;
	if (range.to !== null && ts >= range.to) return false;
	return true;
}

function isInTurnRange(item: DisplayItem): boolean {
	if (!turnRange) return false;
	// Tool groups span multiple turns — check if ANY constituent timestamp matches
	if (item.kind === "toolGroup") {
		return item.timestamps.some((ts) => tsInRange(ts, turnRange));
	}
	const ts = item.earliest;
	if (!ts) return false;
	return tsInRange(ts, turnRange);
}

// Scroll to first item in the selected turn range
let prevTurnFrom: string | null = null;
$effect(() => {
	const from = turnRange?.from ?? null;
	if (from === prevTurnFrom) return;
	prevTurnFrom = from;
	if (!from || !scrollContainer) return;

	tick().then(() => {
		requestAnimationFrame(() => {
			if (!scrollContainer) return;
			const target = scrollContainer.querySelector("[data-turn-active]") as HTMLElement | null;
			if (target) {
				const containerTop = scrollContainer.getBoundingClientRect().top;
				const targetTop = target.getBoundingClientRect().top;
				const offset = targetTop - containerTop + scrollContainer.scrollTop - 12;
				scrollContainer.scrollTo({ top: offset, behavior: "smooth" });
			}
		});
	});
});

// Parse a tool_call content + results into ToolEntry items
function parseToolCallEntries(item: ToolCallItem): ToolEntry[] {
	try {
		const parsed = JSON.parse(item.content);
		if (!Array.isArray(parsed))
			return [
				{
					name: "tool",
					input: item.content,
					id: "",
					result: item.toolResults?.[0]?.content,
					exitCode: item.toolResults?.[0]?.exit_code,
					timestamp: item.earliest,
				},
			];
		return (parsed as Array<{ type: string; id: string; name: string; input: unknown }>).map(
			(use) => {
				const matched = item.toolResults?.find((r) => r.tool_name === use.id);
				return {
					name: use.name,
					input: use.input,
					id: use.id,
					result: matched?.content,
					exitCode: matched?.exit_code,
					timestamp: item.earliest,
				};
			},
		);
	} catch {
		return [
			{
				name: "tool",
				input: item.content,
				id: "",
				result: item.toolResults?.[0]?.content,
				exitCode: item.toolResults?.[0]?.exit_code,
				timestamp: item.earliest,
			},
		];
	}
}

let displayItems = $derived.by((): DisplayItem[] => {
	// Pass 1: pair tool_call with nearby tool_results.
	// Skips over assistant/system messages between tool_call and tool_result,
	// since LLMs may emit reasoning text mid-tool-turn.
	const pass1: Pass1Entry[] = [];
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role === "tool_call") {
			const results: Message[] = [];
			const inlineReasoning: string[] = [];
			let j = i + 1;
			while (j < messages.length) {
				const next = messages[j];
				if (next.role === "tool_result") {
					results.push(next);
					j++;
				} else if (
					(next.role === "assistant" || next.role === "system") &&
					j + 1 < messages.length &&
					(messages[j + 1].role === "tool_result" || messages[j + 1].role === "tool_call")
				) {
					// Collect reasoning/system between tool messages
					const text = next.content?.trim();
					if (text) inlineReasoning.push(text);
					j++;
				} else {
					break;
				}
			}
			pass1.push({
				kind: "toolCall",
				item: {
					content: msg.content,
					toolResults: results.length > 0 ? results : undefined,
					reasoning: inlineReasoning.length > 0 ? inlineReasoning : undefined,
					earliest: msg.created_at ?? "",
				},
			});
			i = j;
		} else {
			pass1.push({ kind: "message", msg, earliest: msg.created_at ?? "" });
			i++;
		}
	}

	// Pass 2: merge consecutive toolCall items into groups with interleaved reasoning.
	const items: DisplayItem[] = [];
	let k = 0;
	while (k < pass1.length) {
		const entry = pass1[k];
		if (entry.kind === "toolCall") {
			const segments: ToolGroupSegment[] = [];
			const timestamps: string[] = [];
			let earliest = "";

			while (k < pass1.length) {
				const cur = pass1[k];
				if (cur.kind === "toolCall") {
					if (!earliest) earliest = cur.item.earliest;
					timestamps.push(cur.item.earliest);
					// Add inline reasoning from Pass 1 (between tool_call and tool_result)
					if (cur.item.reasoning && cur.item.reasoning.length > 0) {
						for (const text of cur.item.reasoning) {
							segments.push({ kind: "reasoning", text });
						}
					}
					// Add tool entries
					const entries = parseToolCallEntries(cur.item);
					segments.push({ kind: "tools", entries });
					k++;
				} else if (
					cur.kind === "message" &&
					cur.msg.role === "assistant" &&
					k + 1 < pass1.length &&
					pass1[k + 1].kind === "toolCall"
				) {
					// Reasoning between tool turns — add as separate segment
					const text = cur.msg.content?.trim();
					if (text) segments.push({ kind: "reasoning", text });
					k++;
				} else {
					break;
				}
			}
			items.push({
				kind: "toolGroup",
				segments,
				earliest,
				timestamps: timestamps.filter(Boolean),
			});
		} else {
			items.push({ kind: "message", msg: entry.msg, earliest: entry.earliest });
			k++;
		}
	}
	return items;
});
</script>

<div class="board">
	<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
		<TurnIndicator
			{lineColor}
			isActive={isAgentActive}
			turnBoundaryOffsets={computedTurnOffsets}
			scrollHeight={contentScrollHeight}
		/>
		{#if messages.length === 0 && emptyText}
			<div class="empty-state">
				<p>{emptyText}</p>
			</div>
		{:else}
			{#each displayItems as item}
				{@const active = turnRange ? isInTurnRange(item) : true}
				<div
					class="display-item"
					class:dimmed={turnRange !== null && !active}
					data-turn-active={active && turnRange ? "" : undefined}
					data-message-id={item.kind === "message" ? item.msg.id : undefined}
					data-message-role={item.kind === "message" ? item.msg.role : undefined}
				>
					{#if item.kind === "toolGroup"}
						<ToolCallGroup segments={item.segments} {turnRange} />
					{:else}
						<MessageBubble
							role={item.msg.role as "user" | "assistant" | "system" | "alert" | "tool_call" | "tool_result"}
							content={item.msg.content}
							toolName={item.msg.tool_name}
							modelId={item.msg.model_id}
							exitCode={item.msg.exit_code}
							{threadColor}
						/>
					{/if}
				</div>
			{/each}
		{/if}
		{#if waiting}
			<div class="waiting-indicator">
				<span class="waiting-dot"></span>
				<span class="waiting-dot"></span>
				<span class="waiting-dot"></span>
				<span class="waiting-label">Thinking...</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.board {
		background: var(--paper);
		border: none;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		position: relative;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 24px 36px 0 36px;
		min-height: 0;
		position: relative;
	}

	.messages::after {
		content: "";
		display: block;
		height: 32px;
		flex-shrink: 0;
	}

	.display-item {
		transition: opacity 0.3s ease;
		margin-bottom: 4px;
	}

	.display-item.dimmed {
		opacity: 0.32;
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--ink-4);
		font-family: var(--font-display);
		font-size: 13px;
		font-style: italic;
	}

	.waiting-indicator {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 0;
		margin-top: 6px;
	}

	.waiting-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ink-3);
		animation: waiting-bounce 1.2s ease-in-out infinite;
	}

	.waiting-dot:nth-child(2) { animation-delay: 0.2s; }
	.waiting-dot:nth-child(3) { animation-delay: 0.4s; }

	@keyframes waiting-bounce {
		0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
		40% { opacity: 1; transform: scale(1); }
	}

	.waiting-label {
		font-family: var(--font-display);
		font-size: 13px;
		color: var(--ink-2);
		margin-left: 4px;
	}

	@media (prefers-reduced-motion: reduce) {
		.waiting-dot { animation: none; }
		.messages { scroll-behavior: auto; }
	}
</style>
