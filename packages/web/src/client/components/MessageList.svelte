<script lang="ts">
import { onMount, tick } from "svelte";
import MessageBubble from "./MessageBubble.svelte";
import ToolCallCard from "./ToolCallCard.svelte";

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

// --- Turn range highlighting + scroll ---
function tsInRange(ts: string | undefined, range: TurnRange): boolean {
	if (!ts) return false;
	if (ts < range.from) return false;
	if (range.to !== null && ts >= range.to) return false;
	return true;
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
// surface the result inline beneath its originating tool_use row.
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

// Group consecutive tool_call messages into a single display item.
type DisplayItem =
	| { kind: "message"; msg: Message; key: string; earliest: string | undefined }
	| {
			kind: "toolGroup";
			messages: Message[];
			key: string;
			earliest: string | undefined;
			timestamps: string[];
	  };

const displayItems = $derived.by((): DisplayItem[] => {
	const items: DisplayItem[] = [];
	let i = 0;
	while (i < messages.length) {
		const m = messages[i];
		if (m.role === "tool_result") {
			i++;
			continue;
		}
		if (m.role === "tool_call") {
			const group: Message[] = [m];
			let j = i + 1;
			while (j < messages.length) {
				const next = messages[j];
				if (next.role === "tool_call") {
					group.push(next);
					j++;
				} else if (next.role === "tool_result") {
					j++;
				} else {
					break;
				}
			}
			// Key on the group's first message id so appending a new
			// tool_call to the in-progress run doesn't mutate the key and
			// remount the ToolCallCard. A remount would reset the group's
			// expanded state, every per-tool expandedTools entry, and every
			// child ReasoningBlock's open disclosure — producing the "my
			// collapsible snaps shut when a new message arrives" bug.
			const anchor = group[0];
			const key = anchor.id ?? anchor.created_at ?? `tg-${i}`;
			items.push({
				kind: "toolGroup",
				messages: group,
				key,
				earliest: group[0].created_at,
				timestamps: group.map((g) => g.created_at ?? "").filter(Boolean),
			});
			i = j;
		} else {
			items.push({
				kind: "message",
				msg: m,
				key: m.id ?? m.created_at ?? `m-${i}`,
				earliest: m.created_at,
			});
			i++;
		}
	}
	return items;
});

function isItemInRange(item: DisplayItem): boolean {
	if (!turnRange) return true;
	if (item.kind === "toolGroup") {
		return item.timestamps.some((ts) => tsInRange(ts, turnRange));
	}
	return tsInRange(item.earliest, turnRange);
}

// Render time as HH:MM in the local timezone — matches the reference
// signage aesthetic (tabular-numeric mono, 24-hour).
function fmtTime(iso: string | undefined): string {
	if (!iso) return "";
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	} catch {
		return "";
	}
}

function dotKind(item: DisplayItem): "user" | "assistant" | "alert" | "system" {
	if (item.kind === "toolGroup") return "assistant";
	const role = item.msg.role;
	if (role === "user") return "user";
	if (role === "alert") return "alert";
	if (role === "system") return "system";
	return "assistant";
}
</script>

<div class="board">
	<div class="messages" bind:this={scrollContainer} onscroll={handleScroll}>
		{#if displayItems.length === 0 && emptyText}
			<div class="empty-state">
				<p>{emptyText}</p>
			</div>
		{:else}
			{#each displayItems as item, i (item.key)}
				{@const active = isItemInRange(item)}
				{@const kind = dotKind(item)}
				{@const isFirst = i === 0}
				<div
					class="turn-row"
					class:dimmed={turnRange !== null && !active}
					data-turn-active={active && turnRange ? "" : undefined}
					data-message-id={item.kind === "message" ? item.msg.id : undefined}
					data-message-role={item.kind === "message" ? item.msg.role : "tool_call"}
				>
					<div class="time-gutter mono">{fmtTime(item.earliest)}</div>
					<div class="rail">
						<div class="rail-line" style="background: {lineColor}"></div>
						{#if isFirst}
							<div class="rail-cap"></div>
						{/if}
						<div
							class="rail-dot rail-dot-{kind}"
							style={kind === "assistant" ? `background: ${lineColor}; border-color: ${lineColor}` : ""}
						></div>
					</div>
					<div class="row-content">
						{#if item.kind === "toolGroup"}
							<ToolCallCard
								messages={item.messages}
								resultsByToolUseId={resultsByToolUseId}
								{lineColor}
							/>
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
				</div>
			{/each}
		{/if}
		{#if waiting || isAgentActive}
			<div class="turn-row thinking-row">
				<div class="time-gutter"></div>
				<div class="rail">
					<div class="rail-line rail-line-dashed" style="border-left-color: {lineColor}"></div>
					<div
						class="rail-dot rail-dot-pulsing"
						style="border-color: {lineColor}"
					></div>
				</div>
				<div class="row-content">
					<div class="role-label">Agent</div>
					<div class="thinking-caption">
						<span>Thinking</span>
						<span class="dots">
							<span class="dot"></span>
							<span class="dot"></span>
							<span class="dot"></span>
						</span>
					</div>
				</div>
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

	/* Per-turn grid: 70px time gutter | 32px rail | 1fr content.
	 * Each row owns its own rail so the vertical track is contiguous across
	 * consecutive rows, while the dot punches over the line via a paper
	 * box-shadow ring. */
	.turn-row {
		display: grid;
		grid-template-columns: 70px 32px 1fr;
		column-gap: 18px;
		align-items: flex-start;
		position: relative;
		transition: opacity 0.3s ease;
	}

	.turn-row.dimmed {
		opacity: 0.32;
	}

	.time-gutter {
		text-align: right;
		padding-top: 6px;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 12px;
		color: var(--ink-2);
		letter-spacing: 0.02em;
	}

	.rail {
		position: relative;
		align-self: stretch;
		display: flex;
		justify-content: center;
		min-height: 36px;
	}

	.rail-line {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 4px;
		left: 50%;
		transform: translateX(-50%);
	}

	.rail-line-dashed {
		background: transparent;
		border-left: 4px dashed;
		opacity: 0.45;
		width: 0;
	}

	/* Paper cap hides the rail above the first dot so the line doesn't
	 * extend past the top of the thread. */
	.rail-cap {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 14px;
		background: var(--paper);
		z-index: 1;
	}

	.rail-dot {
		position: relative;
		z-index: 2;
		margin-top: 12px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 3px solid;
		box-shadow: 0 0 0 4px var(--paper);
		flex-shrink: 0;
	}

	.rail-dot-user {
		background: var(--ink);
		border-color: var(--ink);
	}

	.rail-dot-alert {
		background: var(--accent);
		border-color: var(--accent);
	}

	.rail-dot-system {
		background: var(--ink-3);
		border-color: var(--ink-3);
	}

	.rail-dot-pulsing {
		background: var(--paper);
		animation: rail-dot-pulse 1.4s ease-in-out infinite;
	}

	@keyframes rail-dot-pulse {
		0%, 100% { transform: scale(1); opacity: 1; }
		50% { transform: scale(1.15); opacity: 0.7; }
	}

	.row-content {
		min-width: 0;
	}

	.thinking-row {
		padding-bottom: 20px;
	}

	.role-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-2);
		margin-bottom: 4px;
	}

	.thinking-caption {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.dots {
		display: inline-flex;
		gap: 3px;
	}

	.dots .dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--ink-3);
		animation: thinking-dot 1.4s ease-in-out infinite;
	}

	.dots .dot:nth-child(2) { animation-delay: 0.2s; }
	.dots .dot:nth-child(3) { animation-delay: 0.4s; }

	@keyframes thinking-dot {
		0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
		40% { opacity: 1; transform: scale(1); }
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--ink-4);
		font-family: var(--font-display);
		font-size: 13px;
		font-style: italic;
	}

	@media (prefers-reduced-motion: reduce) {
		.rail-dot-pulsing { animation: none; }
		.dots .dot { animation: none; }
		.messages { scroll-behavior: auto; }
	}
</style>
