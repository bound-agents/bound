<script lang="ts">
import MessageBubble from "./MessageBubble.svelte";

interface Message {
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
}

interface Props {
	messages: Message[];
	waiting?: boolean;
	emptyText?: string | null;
}

const { messages, waiting = false, emptyText = null }: Props = $props();
</script>

<div class="board">
	<div class="messages">
		{#if messages.length === 0 && emptyText}
			<div class="empty-state">
				<p>{emptyText}</p>
			</div>
		{:else}
			{#each messages as msg}
				<MessageBubble
					role={msg.role}
					content={msg.content}
					toolName={msg.tool_name}
					modelId={msg.model_id}
				/>
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
	}
</style>
