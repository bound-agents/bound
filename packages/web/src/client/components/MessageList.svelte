<script lang="ts">
import { onMount, tick } from "svelte";
import MessageBubble from "./MessageBubble.svelte";
import ToolCallGroup from "./ToolCallGroup.svelte";

interface Message {
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
}

interface ToolEntry {
	name: string;
	input: unknown;
	id: string;
	result?: string;
}

interface ToolCallItem {
	content: string;
	toolResults?: Message[];
}

type DisplayItem =
	| { kind: "message"; msg: Message }
	| { kind: "toolGroup"; entries: ToolEntry[] };

interface Props {
	messages: Message[];
	waiting?: boolean;
	emptyText?: string | null;
}

const { messages, waiting = false, emptyText = null }: Props = $props();

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
	scrollContainer.scrollTo({
		top: scrollContainer.scrollHeight,
		behavior: smooth ? "smooth" : "instant",
	});
}

function handleScroll(): void {
	isAtBottom = checkIsAtBottom();
}

// Scroll to bottom on mount (case 2: opening a thread)
onMount(() => {
	tick().then(scrollToBottom);
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
		tick().then(scrollToBottom);
	}

	prevMessageCount = count;
});

// Parse a tool_call content + results into ToolEntry items
function parseToolCallEntries(item: ToolCallItem): ToolEntry[] {
	try {
		const parsed = JSON.parse(item.content);
		if (!Array.isArray(parsed)) return [{ name: "tool", input: item.content, id: "", result: item.toolResults?.[0]?.content }];
		return (parsed as Array<{ type: string; id: string; name: string; input: unknown }>).map((use) => {
			const matched = item.toolResults?.find((r) => r.tool_name === use.id);
			return { name: use.name, input: use.input, id: use.id, result: matched?.content };
		});
	} catch {
		return [{ name: "tool", input: item.content, id: "", result: item.toolResults?.[0]?.content }];
	}
}

let displayItems = $derived.by((): DisplayItem[] => {
	// Pass 1: pair tool_call with consecutive tool_results
	const pass1: Array<{ kind: "message"; msg: Message } | { kind: "toolCall"; item: ToolCallItem }> = [];
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role === "tool_call") {
			const results: Message[] = [];
			let j = i + 1;
			while (j < messages.length && messages[j].role === "tool_result") {
				results.push(messages[j]);
				j++;
			}
			pass1.push({ kind: "toolCall", item: { content: msg.content, toolResults: results.length > 0 ? results : undefined } });
			i = j;
		} else {
			pass1.push({ kind: "message", msg });
			i++;
		}
	}

	// Pass 2: merge consecutive toolCall items into groups.
	// Assistant messages between tool turns (thinking-out-loud text the LLM emits
	// alongside tool calls) are absorbed into the group so they don't break the chain.
	const items: DisplayItem[] = [];
	let k = 0;
	while (k < pass1.length) {
		const entry = pass1[k];
		if (entry.kind === "toolCall") {
			const batch: ToolCallItem[] = [];
			while (k < pass1.length) {
				const cur = pass1[k];
				if (cur.kind === "toolCall") {
					batch.push(cur.item);
					k++;
				} else if (
					cur.kind === "message" &&
					cur.msg.role === "assistant" &&
					k + 1 < pass1.length &&
					pass1[k + 1].kind === "toolCall"
				) {
					// Skip assistant messages that sit between tool turns
					k++;
				} else {
					break;
				}
			}
			const allEntries = batch.flatMap(parseToolCallEntries);
			items.push({ kind: "toolGroup", entries: allEntries });
		} else {
			items.push(entry);
			k++;
		}
	}
	return items;
});
</script>

<div class="board">
	<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
		{#if messages.length === 0 && emptyText}
			<div class="empty-state">
				<p>{emptyText}</p>
			</div>
		{:else}
			{#each displayItems as item}
				{#if item.kind === "toolGroup"}
					<ToolCallGroup entries={item.entries} />
				{:else}
					<MessageBubble
						role={item.msg.role}
						content={item.msg.content}
						toolName={item.msg.tool_name}
						modelId={item.msg.model_id}
					/>
				{/if}
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
		background: rgba(10, 10, 20, 0.5);
		border: 1px solid var(--bg-surface);
		border-radius: 8px;
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
		padding: 12px 12px 0 12px;
		min-height: 0;
		position: relative;
	}

	.messages::after {
		content: "";
		display: block;
		height: 32px;
		flex-shrink: 0;
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--text-muted);
		font-family: var(--font-body);
		font-size: var(--text-sm);
	}

	.waiting-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 16px;
		margin-top: 8px;
	}

	.waiting-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--status-active);
		animation: waiting-bounce 1.2s ease-in-out infinite;
	}

	.waiting-dot:nth-child(2) {
		animation-delay: 0.2s;
	}

	.waiting-dot:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes waiting-bounce {
		0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
		40% { opacity: 1; transform: scale(1); }
	}

	.waiting-label {
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin-left: 4px;
	}

	@media (prefers-reduced-motion: reduce) {
		.waiting-dot {
			animation: none;
		}

		.messages {
			scroll-behavior: auto;
		}
	}
</style>
