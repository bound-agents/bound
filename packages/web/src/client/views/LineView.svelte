<script lang="ts">
import { onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import MessageBubble from "../components/MessageBubble.svelte";
import { api } from "../lib/api";
import { connectWebSocket, subscribeToThread } from "../lib/websocket";

export let threadId: string;

let messages = [];
let inputText = "";
// biome-ignore lint/correctness/noUnusedVariables: used in template
let sending = false;

onMount(async () => {
	try {
		await api.getThread(threadId);
		messages = await api.listMessages(threadId);
		connectWebSocket();
		subscribeToThread(threadId);
	} catch (error) {
		console.error("Failed to load thread:", error);
	}
});

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function handleSendMessage(): Promise<void> {
	if (!inputText.trim()) return;

	sending = true;
	try {
		const newMessage = await api.sendMessage(threadId, inputText);
		messages = [...messages, newMessage];
		inputText = "";
	} catch (error) {
		console.error("Failed to send message:", error);
	}
	sending = false;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function handleBackClick(): void {
	navigateTo("/");
}
</script>

<div class="line-view">
	<div class="header">
		<button on:click={handleBackClick} class="back-button">← Back</button>
		<h1>Conversation</h1>
	</div>

	<div class="messages">
			{#each messages as msg}
				<MessageBubble role={msg.role} content={msg.content} />
			{/each}
		</div>

		<div class="input-area">
			<textarea
				bind:value={inputText}
				placeholder="Type your message..."
				disabled={sending}
			/>
			<button
				on:click={handleSendMessage}
				disabled={sending || !inputText.trim()}
				class="send-button"
			>
				{sending ? "Sending..." : "Send"}
			</button>
		</div>
</div>

<style>
	.line-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 20px;
	}

	.header {
		display: flex;
		gap: 20px;
		align-items: center;
		margin-bottom: 20px;
	}

	h1 {
		flex: 1;
		margin: 0;
		color: #e0e0e0;
	}

	.back-button {
		padding: 8px 16px;
		background: #16213e;
		border: 1px solid #0f3460;
		color: #e0e0e0;
		border-radius: 4px;
		cursor: pointer;
		transition: background 200ms;
	}

	.back-button:hover {
		background: #1e2d50;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding-right: 10px;
		margin-bottom: 20px;
	}

	.input-area {
		display: flex;
		gap: 10px;
	}

	textarea {
		flex: 1;
		padding: 10px;
		background: #16213e;
		border: 1px solid #0f3460;
		color: #e0e0e0;
		border-radius: 4px;
		font-family: inherit;
		resize: vertical;
		min-height: 60px;
	}

	textarea:disabled {
		opacity: 0.5;
	}

	.send-button {
		padding: 10px 20px;
		background: #00a884;
		border: none;
		color: white;
		border-radius: 4px;
		cursor: pointer;
		transition: background 200ms;
		align-self: flex-end;
	}

	.send-button:hover:not(:disabled) {
		background: #00c994;
	}

	.send-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
