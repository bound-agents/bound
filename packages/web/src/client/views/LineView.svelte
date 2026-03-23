<script lang="ts">
import { onDestroy, onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import MessageBubble from "../components/MessageBubble.svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
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
let thread = $state<Thread | null>(null);

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
		thread = await api.getThread(threadId);
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

// biome-ignore lint/correctness/noUnusedVariables: used in template
function viewTitle(): string {
	if (thread && thread.title && thread.title.trim().length > 0) {
		return thread.title.trim();
	}
	if (messages.length === 0) {
		return "New Conversation";
	}
	return "Conversation";
}
</script>

<div class="line-view">
	<div class="header">
		<button onclick={handleBackClick} class="back-button">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
			Map
		</button>
		<h1>{viewTitle()}</h1>
		{#if agentActive}
			<span class="thinking-indicator">
				<span class="thinking-dot"></span>
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

	<div class="bottom-area">
		<div class="file-upload-area">
			<label class="file-label" for="file-input">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M7 1V13M1 7H13" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				Attach
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
				{#if sending}
					<span class="sending-indicator"></span>
				{:else}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<path d="M2 9L16 2L9 16L7.5 10.5L2 9Z" fill="currentColor" />
					</svg>
				{/if}
				<span class="send-label">{sending ? "Sending" : "Send"}</span>
			</button>
		</div>
	</div>
</div>

<style>
	.line-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		max-width: 48rem;
		margin: 0 auto;
		padding: 24px;
		overflow: hidden;
	}

	.header {
		display: flex;
		gap: 16px;
		align-items: center;
		margin-bottom: 24px;
		flex-shrink: 0;
	}

	h1 {
		flex: 1;
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.back-button {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		color: var(--text-secondary);
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
		flex-shrink: 0;
	}

	.back-button:hover {
		background: var(--bg-surface);
		color: var(--text-primary);
	}

	.thinking-indicator {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		color: var(--status-active);
		flex-shrink: 0;
	}

	.thinking-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--status-active);
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(0.8); }
	}

	.cancel-button {
		padding: 8px 16px;
		background: rgba(255, 23, 68, 0.1);
		border: 1px solid var(--alert-disruption);
		color: var(--alert-disruption);
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
		flex-shrink: 0;
	}

	.cancel-button:hover {
		background: rgba(255, 23, 68, 0.2);
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding-right: 8px;
		min-height: 0;
	}

	.bottom-area {
		flex-shrink: 0;
		padding-top: 16px;
		border-top: 1px solid var(--bg-surface);
	}

	.file-upload-area {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}

	.file-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 14px;
		background: var(--bg-surface);
		border: 1px solid rgba(156, 174, 183, 0.2);
		color: var(--text-secondary);
		border-radius: 6px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 600;
		transition: all 0.2s ease;
		user-select: none;
	}

	.file-label:hover {
		background: #1a4a8a;
		color: var(--text-primary);
	}

	.file-input {
		display: none;
	}

	.upload-status {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--status-active);
	}

	.input-area {
		display: flex;
		gap: 12px;
		align-items: flex-end;
	}

	textarea {
		flex: 1;
		padding: 12px 16px;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		color: var(--text-primary);
		border-radius: 8px;
		font-family: var(--font-body);
		font-size: var(--text-base);
		resize: vertical;
		min-height: 56px;
		max-height: 180px;
		transition: border-color 0.2s ease;
		line-height: 1.5;
	}

	textarea:focus {
		outline: none;
		border-color: var(--line-7);
	}

	textarea::placeholder {
		color: var(--text-muted);
	}

	textarea:disabled {
		opacity: 0.4;
	}

	.send-button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px 24px;
		background: var(--line-7);
		border: none;
		color: #fff;
		border-radius: 8px;
		cursor: pointer;
		font-family: var(--font-display);
		font-size: var(--text-sm);
		font-weight: 600;
		transition: all 0.2s ease;
		flex-shrink: 0;
		height: 48px;
	}

	.send-button:hover:not(:disabled) {
		background: #00c9b0;
		box-shadow: 0 0 16px rgba(0, 172, 155, 0.25);
	}

	.send-button:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.send-label {
		font-size: var(--text-sm);
	}

	.sending-indicator {
		width: 14px;
		height: 14px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	@media (prefers-reduced-motion: reduce) {
		.thinking-dot, .sending-indicator {
			animation: none;
		}
	}
</style>
