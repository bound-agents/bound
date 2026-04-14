<script lang="ts">
import type { Thread } from "../lib/api";
import { formatRelativeTime, isToday } from "../lib/format-time";
import { getLineColor } from "../lib/metro-lines";
import { LineBadge, MetroCard, StatusChip } from "./shared";

interface Props {
	threads: Thread[];
	threadStatuses: Map<string, { active: boolean }>;
	selectedThreadId?: string | null;
	onSelectThread?: (threadId: string) => void;
	onNavigateThread?: (threadId: string) => void;
	onHoverThread?: (threadId: string | null) => void;
}

let {
	threads,
	threadStatuses,
	selectedThreadId,
	onSelectThread,
	onNavigateThread,
	onHoverThread,
}: Props = $props();

function sanitizeTitle(title: string | null): string {
	if (!title || title.trim() === "" || title === ".") return "Untitled";
	let clean = title
		.replace(/<tool_call>[\s\S]*/g, "") // strip tool_call blocks
		.replace(/<\/?[^>]+>/g, "") // strip XML/HTML tags
		.replace(/#+\s+/g, " ") // strip markdown header markers (inline too)
		.replace(/\*\*/g, "") // strip bold markers
		.replace(/\*([^*]*)\*/g, "$1") // strip italic markers
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // strip markdown links
		.replace(/`([^`]*)`/g, "$1") // strip inline code
		.replace(/\s+/g, " ") // collapse whitespace
		.trim();
	if (!clean || clean === ".") return "Untitled";
	return clean;
}

// Enhanced threads with message count and last model (can be added if API supports)
interface EnhancedThread extends Thread {
	messageCount?: number;
	lastModel?: string;
}

// Group threads: today vs older
interface ThreadGroup {
	label: string;
	threads: EnhancedThread[];
}

const threadGroups = $derived.by(() => {
	const sorted = [...threads].sort((a, b) => {
		const aTime = new Date(a.last_message_at).getTime();
		const bTime = new Date(b.last_message_at).getTime();
		return bTime - aTime; // Most recent first
	});

	const today: EnhancedThread[] = [];
	const older: EnhancedThread[] = [];

	for (const thread of sorted) {
		if (isToday(thread.last_message_at)) {
			today.push(thread as EnhancedThread);
		} else {
			older.push(thread as EnhancedThread);
		}
	}

	const groups: ThreadGroup[] = [];
	if (today.length > 0) {
		groups.push({ label: "Today", threads: today });
	}
	if (older.length > 0) {
		groups.push({ label: "Older", threads: older });
	}

	return groups;
});

function handleThreadClick(threadId: string) {
	onSelectThread?.(threadId);
	onNavigateThread?.(threadId);
}

function handleThreadKeydown(e: KeyboardEvent, threadId: string) {
	if (e.key === "Enter") {
		onSelectThread?.(threadId);
		onNavigateThread?.(threadId);
	}
}
</script>

<div class="thread-list">
	{#each threadGroups as group (group.label)}
		<div class="thread-group">
			{#if threadGroups.length > 1}
				<div class="group-separator">
					<span class="group-label">{group.label}</span>
				</div>
			{/if}

			{#each group.threads as thread (thread.id)}
				<div
					class="thread-item"
					class:selected={selectedThreadId === thread.id}
					onclick={() => handleThreadClick(thread.id)}
					onmouseenter={() => onHoverThread?.(thread.id)}
					onmouseleave={() => onHoverThread?.(null)}
					onkeydown={(e) => handleThreadKeydown(e, thread.id)}
					role="button"
					tabindex="0"
				>
					<MetroCard
						accentColor={getLineColor(thread.color)}
						interactive={true}
					>
						{#snippet children()}
							<div class="thread-card-content">
								<div class="thread-header">
									<LineBadge
										lineIndex={thread.color}
										size="standard"
									/>
									<div class="thread-title-area">
										<h3
											class="thread-title"
											title={sanitizeTitle(thread.title)}
										>
											{sanitizeTitle(thread.title)}
										</h3>
									</div>
								</div>

								{#if thread.summary}
									<p class="thread-summary">{thread.summary}</p>
								{/if}

								<div class="thread-metadata">
									<span class="relative-time">
										{formatRelativeTime(thread.last_message_at)}
									</span>

									{#if thread.messageCount}
										<span class="message-count">
											{thread.messageCount}
											{thread.messageCount === 1
												? "message"
												: "messages"}
										</span>
									{/if}

									{#if thread.lastModel}
										<span class="model-pill">
											{thread.lastModel}
										</span>
									{/if}

									{#if threadStatuses.get(thread.id)?.active}
										<StatusChip status="active" />
									{/if}
								</div>
							</div>
						{/snippet}
					</MetroCard>
				</div>
			{/each}
		</div>
	{/each}

	{#if threads.length === 0}
		<div class="empty-state">
			<p>No threads yet. Create one to get started!</p>
		</div>
	{/if}
</div>

<style>
	.thread-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.thread-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.group-separator {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--bg-surface);
	}

	.group-label {
		font-size: var(--text-xs);
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 500;
	}

	.thread-item {
		outline: none;
	}

	.thread-item:focus-visible {
		outline: 2px solid var(--accent-color, #0066ff);
		outline-offset: 2px;
		border-radius: 8px;
	}

	.thread-card-content {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.thread-header {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.thread-title-area {
		flex: 1;
		min-width: 0;
	}

	.thread-title {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}

	.thread-summary {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.thread-metadata {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.relative-time {
		font-weight: 500;
	}

	.message-count {
		padding: 2px 6px;
		background: var(--bg-surface);
		border-radius: 4px;
	}

	.model-pill {
		padding: 2px 6px;
		background: var(--bg-surface);
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}

	.thread-item.selected :global(.metro-card) {
		background: rgba(42, 48, 68, 0.5);
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--text-muted);
	}

	.empty-state p {
		margin: 0;
		font-size: var(--text-sm);
	}
</style>
