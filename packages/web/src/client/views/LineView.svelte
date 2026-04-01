<script lang="ts">
import { onDestroy, onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import DebugPanelWrapper from "../components/DebugPanelWrapper.svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template
import MessageList from "../components/MessageList.svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
import { modelStore } from "../lib/modelStore";
import { navigateTo } from "../lib/router";
import {
	connectWebSocket,
	disconnectWebSocket,
	subscribeToThread,
	wsEvents,
} from "../lib/websocket";
import { shouldClearWaiting } from "../utils/waiting";

const { threadId } = $props<{ threadId: string }>();

let messages = $state([]);
let inputText = $state("");
// biome-ignore lint/correctness/noUnusedVariables: used in template
let sending = $state(false);
let waiting = $state(false);
let waitingSinceMessageCount = $state(0);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let agentActive = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let agentState = $state<string | null>(null);
// biome-ignore lint/correctness/noUnusedVariables: used in template
// biome-ignore lint/style/useConst: Svelte 5 $state() requires let
let fileInput = $state<HTMLInputElement | null>(null);
// biome-ignore lint/correctness/noUnusedVariables: used in template
let uploadStatus = $state<string | null>(null);
let pendingFileId = $state<string | null>(null);
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
		const msg = last.data as { thread_id?: string; id?: string; role?: string };
		if (msg.thread_id === threadId) {
			// Avoid duplicates by id
			const exists = messages.some((m: { id: string }) => m.id === msg.id);
			if (!exists) {
				messages = [...messages, last.data];
			}
			// Clear waiting indicator when an assistant or alert message arrives
			if (shouldClearWaiting(msg.role ?? "")) {
				waiting = false;
			}
		}
	}
});

async function pollMessages(): Promise<void> {
	try {
		const latest = await api.listMessages(threadId);
		messages = latest;
		// Clear waiting indicator if a new assistant or alert message arrived after we started waiting
		if (
			waiting &&
			latest.length > waitingSinceMessageCount &&
			latest
				.slice(waitingSinceMessageCount)
				.some((m: { role: string }) => shouldClearWaiting(m.role))
		) {
			waiting = false;
		}
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
			// Clear stale waiting indicator if agent is no longer active
			if (waiting && !data.active) {
				waiting = false;
			}
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
	statusPollInterval = setInterval(pollStatus, 2000);
	await pollStatus();
});

onDestroy(() => {
	unsubscribeWs();
	disconnectWebSocket();
	if (pollInterval !== null) clearInterval(pollInterval);
	if (statusPollInterval !== null) clearInterval(statusPollInterval);
});

async function handleSendMessage(): Promise<void> {
	if (!inputText.trim() && !pendingFileId) return;

	sending = true;
	try {
		const newMessage = await api.sendMessage(
			threadId,
			inputText.trim(),
			modelStore.getModel() || undefined,
			pendingFileId ?? undefined,
		);
		messages = [...messages, newMessage];
		inputText = "";
		pendingFileId = null;
		uploadStatus = null;
		waitingSinceMessageCount = messages.length;
		waiting = true;
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
	pendingFileId = null;
	try {
		const res = await fetch("/api/files/upload", { method: "POST", body: form });
		if (res.ok) {
			const uploaded = await res.json();
			pendingFileId = uploaded.id ?? null;
			uploadStatus = `Attached: ${file.name}`;
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
function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		handleSendMessage();
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function viewTitle(): string {
	if (thread?.title && thread.title.trim().length > 0) {
		return thread.title.trim();
	}
	if (messages.length === 0) {
		return "New Conversation";
	}
	return "Conversation";
}
</script>

<DebugPanelWrapper {threadId} {wsEvents}>
	{#snippet children({ debugOpen, toggleDebug })}
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
			<button class="debug-toggle" onclick={toggleDebug} title="Context Debug">
				{debugOpen ? "✕" : "⚙"}
			</button>
		</div>

	<MessageList {messages} {waiting} />

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
				onkeydown={handleKeydown}
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
	{/snippet}
</DebugPanelWrapper>

<style>
	.line-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		max-width: 52rem;
		width: 100%;
		margin: 0 auto;
		padding: 24px;
		overflow: hidden;
		box-sizing: border-box;
	}

	.header {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-bottom: 12px;
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

	.bottom-area {
		flex-shrink: 0;
		padding-top: 10px;
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
		padding: 8px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--bg-surface);
		color: var(--text-primary);
		border-radius: 8px;
		font-family: var(--font-body);
		font-size: var(--text-base);
		resize: vertical;
		min-height: 44px;
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


	.debug-toggle {
		background: var(--bg-surface);
		border: 1px solid var(--bg-surface);
		color: var(--text-secondary);
		padding: 4px 8px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 14px;
		transition: color 0.2s;
		flex-shrink: 0;
	}

	.debug-toggle:hover {
		color: var(--text-primary);
		border-color: var(--line-7);
	}

	@media (prefers-reduced-motion: reduce) {
		.thinking-dot, .sending-indicator {
			animation: none;
		}
	}
</style>
