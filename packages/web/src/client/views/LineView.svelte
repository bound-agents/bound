<script lang="ts">
import { onDestroy, onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import MessageBubble from "../components/MessageBubble.svelte";
import { api } from "../lib/api";
import { navigateTo } from "../lib/router";
import { activeModel } from "../components/ModelSelector.svelte";
import { connectWebSocket, disconnectWebSocket, subscribeToThread, wsEvents } from "../lib/websocket";

const { threadId } = $props<{ threadId: string }>();

let messages = $state([]);
let inputText = $state("");
let sending = $state(false);
let agentActive = $state(false);
let agentState = $state<string | null>(null);
let fileInput: HTMLInputElement | null = null;
let uploadStatus = $state<string | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;
let statusPollInterval: ReturnType<typeof setInterval> | null = null;

// Subscribe to WebSocket events and append new messages
const unsubscribeWs = wsEvents.subscribe((events) => {
	if (events.length === 0) return;
	const last = events[events.length - 1];
	if (
		last &&
		last.type === "message:created" &&
		typeof last.data === "object" &&
		last.data !== null
	) {
		const msg = last.data as { thread_id?: string; id?: string };
		if (msg.thread_id === threadId) {
			// Avoid duplicates by id
			const exists = messages.some((m: { id: string }) => m.id === msg.id);
			if (!exists) {
				messages = [...messages, last.data];
			}
		}
	}
});

async function pollMessages(): Promise<void> {
	try {
		const latest = await api.listMessages(threadId);
		messages = latest;
	} catch (error) {
		console.error("Failed to poll messages:", error);
	}
}

async function pollStatus(): Promise<void> {
	try {
		const res = await fetch(`/api/threads/${threadId}/status`);
		if (res.ok) {
			const data = (await res.json()) as { active: boolean; state: string | null };
			agentActive = data.active;
			agentState = data.state;
		}
	} catch (error) {
		console.error("Failed to poll status:", error);
	}
}

onMount(async () => {
	try {
		await api.getThread(threadId);
		messages = await api.listMessages(threadId);
		connectWebSocket();
		subscribeToThread(threadId);
	} catch (error) {
		console.error("Failed to load thread:", error);
	}

	pollInterval = setInterval(pollMessages, 5000);
	statusPollInterval = setInterval(pollStatus, 5000);
	await pollStatus();
});

onDestroy(() => {
	unsubscribeWs();
	disconnectWebSocket();
	if (pollInterval !== null) clearInterval(pollInterval);
	if (statusPollInterval !== null) clearInterval(statusPollInterval);
});

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function handleSendMessage(): Promise<void> {
	if (!inputText.trim()) return;

	sending = true;
	try {
		const newMessage = await api.sendMessage(threadId, inputText, activeModel || undefined);
		messages = [...messages, newMessage];
		inputText = "";
	} catch (error) {
		console.error("Failed to send message:", error);
	}
	sending = false;
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function handleCancel(): Promise<void> {
	try {
		await fetch(`/api/status/cancel/${threadId}`, { method: "POST" });
	} catch (error) {
		console.error("Failed to cancel agent:", error);
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
async function handleFileChange(e: Event): Promise<void> {
	const input = e.target as HTMLInputElement;
	if (!input.files || input.files.length === 0) return;
	const file = input.files[0];
	const form = new FormData();
	form.append("file", file);
	uploadStatus = "Uploading...";
	try {
		const res = await fetch("/api/files/upload", { method: "POST", body: form });
		if (res.ok) {
			uploadStatus = `Uploaded: ${file.name}`;
		} else {
			uploadStatus = "Upload failed";
		}
	} catch (error) {
		console.error("Failed to upload file:", error);
		uploadStatus = "Upload failed";
	}
	// Reset the input so the same file can be uploaded again
	input.value = "";
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function handleBackClick(): void {
	navigateTo("/");
}
</script>

<div class="line-view">
	<div class="header">
		<button onclick={handleBackClick} class="back-button">← Back</button>
		<h1>Conversation</h1>
		{#if agentActive}
			<span class="thinking-indicator">
				{agentState === "tool_call" ? "Using tool..." : "Thinking..."}
			</span>
			<button onclick={handleCancel} class="cancel-button">Cancel</button>
		{/if}
	</div>

	<div class="messages">
		{#each messages as msg}
			<MessageBubble role={msg.role} content={msg.content} toolName={msg.tool_name} modelId={msg.model_id} />
		{/each}
	</div>

	<div class="file-upload-area">
		<label class="file-label" for="file-input">
			Attach file
			<input
				id="file-input"
				type="file"
				class="file-input"
				onchange={handleFileChange}
				bind:this={fileInput}
			/>
		</label>
		{#if uploadStatus}
			<span class="upload-status">{uploadStatus}</span>
		{/if}
	</div>

	<div class="input-area">
		<textarea
			bind:value={inputText}
			placeholder="Type your message..."
			disabled={sending}
		></textarea>
		<button
			onclick={handleSendMessage}
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
		max-width: 48rem;
		margin: 0 auto;
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

	.thinking-indicator {
		font-size: 13px;
		color: #69f0ae;
		font-style: italic;
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.cancel-button {
		padding: 6px 14px;
		background: #4a1a1a;
		border: 1px solid #ff1744;
		color: #ff1744;
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
		transition: background 200ms;
	}

	.cancel-button:hover {
		background: #6a1a1a;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding-right: 10px;
		margin-bottom: 10px;
	}

	.file-upload-area {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 10px;
	}

	.file-label {
		display: inline-block;
		padding: 6px 14px;
		background: #16213e;
		border: 1px dashed #0f3460;
		color: #a0a0b0;
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
		transition: border-color 200ms;
	}

	.file-label:hover {
		border-color: #1a4a8a;
		color: #e0e0e0;
	}

	.file-input {
		display: none;
	}

	.upload-status {
		font-size: 12px;
		color: #69f0ae;
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
