<script lang="ts">
import { onMount, tick } from "svelte";
import MessageBubble from "./MessageBubble.svelte";
import ToolCallCard from "./ToolCallCard.svelte";
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
const BOTTOM_THRESHOLD = 80;

function checkIsAtBottom(): boolean {
	if (!scrollContainer) return true;
	const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
	return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
}

function scrollToBottom(smooth = true): void {
	if (!scrollContainer) return;
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

onMount(() => {
	tick().then(() => scrollToBottom());
});

$effect(() => {
	const count = messages.length;
	if (count === prevMessageCount) return;

	const lastMsg = messages[count - 1];
	const isNewUserMessage = lastMsg?.role === "user";

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

	const offsets: number[] = [];
	let lastWasUser = false;
	const items = scrollContainer.querySelectorAll("[data-message-role]");
	for (const el of items) {
		const role = el.getAttribute("data-message-role");
		if (role === "user" && !lastWasUser) {
			const offset = (el as HTMLElement).offsetTop;
			offsets.push(offset);
			lastWasUser = true;
		} else if (role === "assistant" || role === "tool_call") {
			lastWasUser = false;
		}
	}
	computedTurnOffsets = offsets;
}

$effect(() => {
	if (messages.length > 0) {
		tick().then(updateScrollMetrics);
	}
});

// --- Turn range highlighting + scroll ---
function tsInRange(ts: string | undefined, range: TurnRange): boolean {
	if (!ts) return false;
	if (ts < range.from) return false;
	if (range.to !== null && ts >= range.to) return false;
	return true;
}

function isInRange(msg: Message): boolean {
	if (!turnRange) return true;
	return tsInRange(msg.created_at, turnRange);
}

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

// Build a lookup from tool_use id → tool_result message so ToolCallCard can
// surface the result inline beneath its originating tool_use row. Results are
// still persisted as separate messages (the pairing invariant), but they no
// longer need to appear as standalone bubbles in the stream — the tool_call
// message's ContentBlock[] is the authoritative record of what was called.
interface ToolResultMsg {
	content: string;
	exit_code?: number | null;
	tool_name?: string | null;
}

const resultsByToolUseId = $derived.by((): Record<string, ToolResultMsg> => {
	const map: Record<string, ToolResultMsg> = {};
	for (const m of messages) {
		if (m.role === "tool_result" && m.tool_name) {
			map[m.tool_name] = {
				content: m.content,
				exit_code: m.exit_code ?? null,
				tool_name: m.tool_name,
			};
		}
	}
	return map;
});

// Tool_result messages are now collapsed into their originating ToolCallCard,
// so they don't render as standalone rows. Every other persisted role renders
// as its own turn — no cross-message grouping, no assistant-text scooping.
const visibleMessages = $derived(messages.filter((m) => m.role !== "tool_result"));
</script>

<div class="board">
	<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
		<TurnIndicator
			{lineColor}
			isActive={isAgentActive}
			turnBoundaryOffsets={computedTurnOffsets}
			scrollHeight={contentScrollHeight}
		/>
		{#if visibleMessages.length === 0 && emptyText}
			<div class="empty-state">
				<p>{emptyText}</p>
			</div>
		{:else}
			{#each visibleMessages as msg (msg.id ?? msg.created_at)}
				{@const active = isInRange(msg)}
				<div
					class="display-item"
					class:dimmed={turnRange !== null && !active}
					data-turn-active={active && turnRange ? "" : undefined}
					data-message-id={msg.id}
					data-message-role={msg.role}
				>
					{#if msg.role === "tool_call"}
						<ToolCallCard
							content={msg.content}
							resultsByToolUseId={resultsByToolUseId}
							{lineColor}
							modelId={msg.model_id}
						/>
					{:else}
						<MessageBubble
							role={msg.role as "user" | "assistant" | "system" | "alert" | "tool_call" | "tool_result"}
							content={msg.content}
							toolName={msg.tool_name}
							modelId={msg.model_id}
							exitCode={msg.exit_code}
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
