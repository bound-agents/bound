<script lang="ts">
import type { Thread } from "@bound/shared";
import { onDestroy, onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import ContextDebugPanel from "../components/ContextDebugPanel.svelte";
import LineBadge from "../components/LineBadge.svelte";
import MessageList from "../components/MessageList.svelte";
import ModelSelector from "../components/ModelSelector.svelte";
import StatusChip from "../components/StatusChip.svelte";
import {
	client,
	connectWebSocket,
	disconnectWebSocket,
	subscribeToThread,
	wsEvents,
} from "../lib/bound";
import { formatRelativeTime } from "../lib/format-time";
import { getLineColor, getLineName } from "../lib/metro-lines";
import { modelStore } from "../lib/modelStore";
import { navigateTo } from "../lib/router";
import { shouldClearWaiting } from "../utils/waiting";

const { threadId } = $props<{ threadId: string }>();

interface LocalMessage {
	id: string;
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
	created_at?: string;
}

let messages = $state<LocalMessage[]>([]);
let inputText = $state("");
let sending = $state(false);
let waiting = $state(false);
let waitingSinceMessageCount = $state(0);
let agentActive = $state(false);
let agentState = $state<string | null>(null);
let uploadStatus = $state<string | null>(null);
let pendingFileId = $state<string | null>(null);
let thread = $state<Thread | null>(null);
let panelMode = $state<"context" | "debugger">("context");

// A selected-turn range emitted by the debugger's turn scrubber. When set, the
// conversation dims other turns and scrolls the selected one into view.
let turnRange = $state<{ from: string; to: string | null } | null>(null);

let pollInterval: ReturnType<typeof setInterval> | null = null;

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
			const exists = messages.some((m) => m.id === msg.id);
			if (!exists) {
				messages = [...messages, last.data as LocalMessage];
			}
			if (shouldClearWaiting(msg.role ?? "")) {
				waiting = false;
			}
		}
	}
});

async function pollMessages(): Promise<void> {
	try {
		const latest = (await client.listMessages(threadId)) as unknown as LocalMessage[];
		messages = latest;
		if (
			waiting &&
			latest.length > waitingSinceMessageCount &&
			latest.slice(waitingSinceMessageCount).some((m) => shouldClearWaiting(m.role))
		) {
			waiting = false;
		}
	} catch (error) {
		console.error("Failed to poll messages:", error);
	}
}

function handleThreadStatus(data: unknown): void {
	const status = data as { active?: boolean; state?: string | null };
	agentActive = status.active ?? false;
	agentState = status.state ?? null;
	if (waiting && !status.active) waiting = false;
}

onMount(async () => {
	try {
		thread = await client.getThread(threadId);
		messages = (await client.listMessages(threadId)) as unknown as LocalMessage[];
		connectWebSocket();
		subscribeToThread(threadId);
	} catch (error) {
		console.error("Failed to load thread:", error);
	}

	pollInterval = setInterval(pollMessages, 5000);
	client.on("thread:status", handleThreadStatus);

	try {
		const data = await client.getThreadStatus(threadId);
		handleThreadStatus(data);
	} catch (error) {
		console.error("Failed to load thread status:", error);
	}
});

onDestroy(() => {
	unsubscribeWs();
	disconnectWebSocket();
	if (pollInterval !== null) clearInterval(pollInterval);
	client.off("thread:status", handleThreadStatus);
});

function handleSendMessage(): void {
	if (!inputText.trim() && !pendingFileId) return;
	sending = true;
	try {
		client.sendMessage(threadId, inputText.trim(), {
			modelId: modelStore.getModel() || undefined,
			fileId: pendingFileId ?? undefined,
		});
		inputText = "";
		pendingFileId = null;
		uploadStatus = null;
		waitingSinceMessageCount = messages.length;
		waiting = true;
	} catch (error) {
		console.error("Failed to send message:", error);
	} finally {
		sending = false;
	}
}

async function handleCancel(): Promise<void> {
	try {
		await client.cancelThread(threadId);
	} catch (error) {
		console.error("Failed to cancel agent:", error);
	}
}

let fileInputEl: HTMLInputElement | null = null;

async function handleFileChange(e: Event): Promise<void> {
	const input = e.target as HTMLInputElement;
	if (!input.files || input.files.length === 0) return;
	const file = input.files[0];
	uploadStatus = "Uploading…";
	pendingFileId = null;
	try {
		const uploaded = await client.uploadFile(file, file.name);
		pendingFileId = uploaded.id ?? null;
		uploadStatus = `Attached · ${file.name}`;
	} catch (error) {
		console.error("Failed to upload file:", error);
		uploadStatus = "Upload failed";
	}
	input.value = "";
}

function handleBackClick(): void {
	navigateTo("/");
}

function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		handleSendMessage();
	}
}

function viewTitle(): string {
	if (thread?.title && thread.title.trim().length > 0) return thread.title.trim();
	if (messages.length === 0) return "New Conversation";
	return "Conversation";
}

const lineColor = $derived(thread ? getLineColor(thread.color) : "#999");
const lineName = $derived(thread ? getLineName(thread.color) : "");

// Right-side Context pane info
const allToolCalls = $derived(messages.filter((m) => m.role === "tool_call").length);
const firstMessageAt = $derived(messages[0]?.created_at ?? null);

// Thread's active model: prefer the most recent assistant/tool_call message's
// model_id (reflects any operator model switch mid-thread), falling back to
// the global modelStore's selection.
const activeModel = $derived.by((): string => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const mid = messages[i].model_id;
		if (mid) return mid;
	}
	return modelStore.getModel() || "—";
});

// User-message turn stops for the mini-timeline in the Context pane. Each
// user message is a "stop" on the line; the last is the current turn.
const userTurns = $derived(messages.filter((m) => m.role === "user"));

function fmtHhmm(iso: string | undefined | null): string {
	if (!iso) return "";
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	} catch {
		return "";
	}
}

function turnPreview(content: string): string {
	const compact = (content ?? "").replace(/\s+/g, " ").trim();
	if (compact.length <= 56) return compact;
	return `${compact.slice(0, 55)}…`;
}
</script>

<div class="line-view" style="--line-color: {lineColor}">
	<!-- Header -->
	<div class="line-header">
		<button class="back-btn" onclick={handleBackClick}>
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
				<path d="M10 12L6 8l4-4" />
			</svg>
			Map
		</button>

		<div class="title-block">
			{#if thread}
				<LineBadge lineIndex={thread.color} size="large" />
			{/if}
			<div class="title-text">
				{#if thread}
					<div class="kicker">{lineName} Line</div>
				{/if}
				<h1 class="title">{viewTitle()}</h1>
			</div>
			{#if thread}
				<StatusChip status={agentActive ? "active" : "idle"} />
			{/if}
			{#if agentActive}
				<span class="agent-state mono">
					{agentState === "tool_call" ? "Using tool…" : "Thinking…"}
				</span>
				<Btn variant="danger" size="sm" onclick={handleCancel}>
					{#snippet children()}Cancel{/snippet}
				</Btn>
			{/if}
		</div>
	</div>

	<!-- Body: conversation + right panel -->
	<div class="body">
		<div class="conversation">
			<MessageList
				{messages}
				{waiting}
				{turnRange}
				threadColor={thread?.color ?? 0}
				{lineColor}
				isAgentActive={agentActive}
			/>

			<!-- Input bar -->
			<div class="input-wrap">
				<div class="input-row">
					<textarea
						bind:value={inputText}
						placeholder="Address the agent…"
						rows={2}
						disabled={sending}
						onkeydown={handleKeydown}
					></textarea>
					<button
						class="dispatch"
						class:active={inputText.trim().length > 0}
						onclick={handleSendMessage}
						disabled={sending || !inputText.trim()}
					>
						{sending ? "Sending" : "Dispatch"}
					</button>
				</div>
				<div class="input-meta">
					<ModelSelector />
					<label class="attach">
						<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
							<path d="M12 4l-6 6c-1 1-1 3 0 4s3 1 4 0l6-6c2-2 2-5 0-7s-5-2-7 0l-7 7c-3 3-3 7 0 10s7 3 10 0l5-5" />
						</svg>
						Attach
						<input
							type="file"
							class="file-input"
							onchange={handleFileChange}
							bind:this={fileInputEl}
						/>
					</label>
					{#if uploadStatus}
						<span class="upload-status mono">{uploadStatus}</span>
					{/if}
					<div class="spacer"></div>
					<span class="hint">⏎ send · ⇧⏎ newline</span>
				</div>
			</div>
		</div>

		<aside class="right-panel">
			<div class="panel-toggle">
				<button
					class="mode-btn"
					class:active={panelMode === "context"}
					onclick={() => (panelMode = "context")}
				>
					Context
				</button>
				<button
					class="mode-btn"
					class:active={panelMode === "debugger"}
					onclick={() => (panelMode = "debugger")}
				>
					Debugger
				</button>
			</div>

			<div class="panel-body">
				{#if panelMode === "context"}
					<div class="context-pane">
						{#if thread}
							<div class="context-header">
								<LineBadge lineIndex={thread.color} size="compact" />
								<span class="line-title">{lineName} Line</span>
							</div>
							<div class="fields">
								<div class="field">
									<span class="kicker">Reference</span>
									<span class="mono">{thread.id.slice(0, 10)}</span>
								</div>
								<div class="field">
									<span class="kicker">Model</span>
									<span class="mono">{activeModel}</span>
								</div>
								<div class="field">
									<span class="kicker">Opened</span>
									<span class="mono">
										{firstMessageAt ? formatRelativeTime(firstMessageAt) : "—"}
									</span>
								</div>
								<div class="field">
									<span class="kicker">Messages</span>
									<span class="mono tnum">{messages.length}</span>
								</div>
								<div class="field">
									<span class="kicker">Tool calls</span>
									<span class="mono tnum">{allToolCalls}</span>
								</div>
								<div class="field">
									<span class="kicker">Status</span>
									<span
										class="mono"
										style="color: {agentActive ? 'var(--ok)' : 'var(--ink-3)'}"
									>
										{agentActive ? "Live" : "Idle"}
									</span>
								</div>
							</div>

							{#if userTurns.length > 0}
								<div class="turns-section">
									<div class="turns-kicker">Turns · {userTurns.length}</div>
									<div class="turns-list">
										{#each userTurns as turn, i}
											{@const isLast = i === userTurns.length - 1}
											<div class="turn-stop" class:turn-stop-current={isLast}>
												<div class="turn-rail">
													{#if !isLast}
														<div
															class="turn-rail-line"
															style="background: {lineColor}"
														></div>
													{/if}
													<div
														class="turn-dot"
														class:turn-dot-current={isLast}
														style={isLast
															? `border-color: ${lineColor}; background: var(--paper)`
															: `background: ${lineColor}; border-color: ${lineColor}`}
													></div>
												</div>
												<div class="turn-body">
													<div class="turn-preview" class:turn-preview-current={isLast}>
														{turnPreview(turn.content)}
													</div>
													<div class="turn-time mono">{fmtHhmm(turn.created_at)}</div>
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						{:else}
							<div class="empty">Loading thread…</div>
						{/if}
					</div>
				{:else}
					<ContextDebugPanel
						{threadId}
						{wsEvents}
						onTurnChange={(range) => (turnRange = range)}
					/>
				{/if}
			</div>
		</aside>
	</div>
</div>

<style>
	.line-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.line-header {
		display: flex;
		align-items: stretch;
		border-bottom: 1px solid var(--ink);
		background: var(--paper);
	}

	.back-btn {
		padding: 0 18px;
		background: var(--paper-3);
		border: none;
		border-right: 1px solid var(--rule-soft);
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12.5px;
		font-weight: 500;
	}

	.back-btn:hover {
		background: var(--paper-2);
	}

	.title-block {
		flex: 1;
		padding: 16px 22px;
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}

	.title-text {
		flex: 1;
		min-width: 0;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.title {
		margin: 2px 0 0;
		font-family: var(--font-header);
		font-size: 26px;
		font-weight: 700;
		letter-spacing: -0.018em;
		line-height: 1.08;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ink);
	}

	.agent-state {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--ok);
	}

	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr 380px;
		border-top: 1px solid var(--rule-soft);
	}

	.conversation {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--paper);
		min-width: 0;
	}

	.input-wrap {
		border-top: 1px solid var(--rule-soft);
		background: var(--paper-2);
		padding: 14px 36px 18px;
		flex-shrink: 0;
	}

	.input-row {
		display: flex;
		gap: 0;
		align-items: stretch;
		border: 1px solid var(--ink);
		background: var(--paper);
	}

	textarea {
		flex: 1;
		padding: 12px 14px;
		border: none;
		outline: none;
		background: transparent;
		resize: none;
		font-family: var(--font-display);
		font-size: 14px;
		line-height: 1.5;
		color: var(--ink);
		min-height: 44px;
	}

	textarea::placeholder {
		color: var(--ink-4);
	}

	textarea:disabled {
		opacity: 0.5;
	}

	.dispatch {
		background: var(--paper-3);
		color: var(--ink-4);
		border: none;
		padding: 0 24px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		cursor: not-allowed;
	}

	.dispatch.active {
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}

	.dispatch.active:hover:not(:disabled) {
		background: var(--accent-2);
	}

	.input-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}

	.attach {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border: 1px dashed var(--rule-soft);
		background: transparent;
		cursor: pointer;
		font-size: 11.5px;
		color: var(--ink-3);
		font-family: var(--font-display);
		font-weight: 500;
		user-select: none;
	}

	.attach:hover {
		color: var(--ink-2);
		border-color: var(--ink-4);
	}

	.file-input {
		display: none;
	}

	.upload-status {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ok);
	}

	.spacer {
		flex: 1;
	}

	.hint {
		font-size: 11px;
		color: var(--ink-4);
	}

	.right-panel {
		background: var(--paper-2);
		border-left: 1px solid var(--rule-soft);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.panel-toggle {
		display: flex;
		padding: 12px 14px;
		border-bottom: 1px solid var(--rule-soft);
		background: var(--paper);
		gap: 0;
		flex-shrink: 0;
	}

	.mode-btn {
		flex: 1;
		padding: 7px 10px;
		background: transparent;
		color: var(--ink-2);
		border: 1px solid var(--rule-soft);
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
	}

	.mode-btn:first-child {
		border-right: none;
	}

	.mode-btn.active {
		background: var(--ink);
		color: var(--paper);
		border-color: var(--ink);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 20px 22px;
	}

	.context-pane .context-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}

	.line-title {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 14px;
		color: var(--ink);
	}

	.fields {
		display: grid;
		row-gap: 8px;
		border-top: 1px solid var(--rule-faint);
		padding-top: 12px;
	}

	.field {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.field .kicker {
		color: var(--ink-4);
	}

	.field .mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: 12px;
		color: var(--ink);
	}

	.empty {
		color: var(--ink-4);
		font-style: italic;
		font-size: 13px;
		text-align: center;
		padding: 32px 0;
	}

	.turns-section {
		margin-top: 20px;
	}

	.turns-kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 10px;
	}

	.turns-list {
		display: flex;
		flex-direction: column;
	}

	.turn-stop {
		display: grid;
		grid-template-columns: 24px 1fr;
		align-items: flex-start;
		min-height: 32px;
	}

	.turn-rail {
		position: relative;
		height: 100%;
		display: flex;
		justify-content: center;
	}

	.turn-rail-line {
		position: absolute;
		top: 14px;
		bottom: -14px;
		width: 3px;
	}

	.turn-dot {
		margin-top: 6px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 2px solid;
		z-index: 1;
	}

	.turn-dot-current {
		width: 12px;
		height: 12px;
	}

	.turn-body {
		padding: 4px 0;
		min-width: 0;
	}

	.turn-preview {
		font-size: 12.5px;
		color: var(--ink-2);
		font-weight: 400;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.turn-preview-current {
		color: var(--ink);
		font-weight: 600;
	}

	.turn-time {
		font-size: 10.5px;
		color: var(--ink-4);
		letter-spacing: 0.06em;
		margin-top: 1px;
	}

	@media (max-width: 960px) {
		.body {
			grid-template-columns: 1fr;
		}
		.right-panel {
			border-left: none;
			border-top: 1px solid var(--rule-soft);
			max-height: 40vh;
		}
	}
</style>
