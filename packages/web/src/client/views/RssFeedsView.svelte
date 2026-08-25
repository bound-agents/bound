<script lang="ts">
import type { ClusterModelInfo, RssFeedListEntry } from "@bound/client";
import { onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import DataTable from "../components/DataTable.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import TaskCard from "../components/TaskCard.svelte";
import TicketTab from "../components/TicketTab.svelte";
import { client } from "../lib/bound";

let feeds: RssFeedListEntry[] = $state([]);
let loading = $state(true);
let view = $state<"list" | "create" | "detail">("list");
let selectedFeed = $state<RssFeedListEntry | null>(null);
let error = $state<string | null>(null);

// Cluster model catalogue (for dropdowns). Empty = use cluster default.
let availableModels: ClusterModelInfo[] = $state([]);
let defaultModel = $state("");

// Create form state
let createName = $state("");
let createUrl = $state("");
let createDescription = $state("");
let createPrompt = $state("");
let createInterval = $state(900);
let createModel = $state(""); // "" = use cluster default
let createNoHistory = $state(false);
let createError = $state<string | null>(null);

// Edit form state
let editUrl = $state("");
let editDescription = $state("");
let editPrompt = $state("");
let editInterval = $state(900);
let editModel = $state(""); // "" = use cluster default
let editNoHistory = $state(false);
let editError = $state<string | null>(null);

// Loading states
let actionInProgress = $state<string | null>(null);

const columns = [
	{ key: "name", label: "Name", width: "2fr", mono: true },
	{ key: "url", label: "Feed URL", width: "3fr", mono: true },
	{ key: "interval", label: "Poll every", width: "1fr" },
	{ key: "created_at", label: "Created", width: "2fr" },
];

onMount(() => {
	loadFeeds();
	loadModels();
});

async function loadFeeds(): Promise<void> {
	try {
		loading = true;
		error = null;
		feeds = await client.listRssFeeds();
	} catch (err: unknown) {
		console.error("Failed to load RSS feeds:", err);
		error = err instanceof Error ? err.message : "Failed to load RSS feeds. Please try again.";
	} finally {
		loading = false;
	}
}

async function loadModels(): Promise<void> {
	// Best-effort: dropdown still falls back to a free-text default if /models fails.
	try {
		const resp = await client.listModels();
		availableModels = resp.models;
		defaultModel = resp.default;
	} catch (err: unknown) {
		console.error("Failed to load models for RSS feed dropdown:", err);
	}
}

async function handleCreate(): Promise<void> {
	if (!createName.trim()) {
		createError = "Name is required";
		return;
	}
	if (!createUrl.trim()) {
		createError = "Feed URL is required";
		return;
	}

	actionInProgress = "create";
	createError = null;

	try {
		await client.createRssFeed({
			name: createName,
			url: createUrl,
			description: createDescription || undefined,
			prompt: createPrompt || undefined,
			poll_interval_seconds: createInterval,
			model_hint: createModel || null,
			no_history: createNoHistory,
		});

		// Reset form
		createName = "";
		createUrl = "";
		createDescription = "";
		createPrompt = "";
		createInterval = 900;
		createModel = "";
		createNoHistory = false;

		await loadFeeds();
		view = "list";
	} catch (err: unknown) {
		console.error("Failed to create RSS feed:", err);
		createError =
			err instanceof Error ? err.message : "Failed to create RSS feed. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

async function handleDelete(id: string): Promise<void> {
	if (!confirm("Are you sure you want to delete this feed? This action cannot be undone.")) {
		return;
	}

	actionInProgress = `delete:${id}`;

	try {
		await client.deleteRssFeed(id);
		await loadFeeds();
		view = "list";
		selectedFeed = null;
	} catch (err: unknown) {
		console.error("Failed to delete RSS feed:", err);
		error = err instanceof Error ? err.message : "Failed to delete RSS feed. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

async function handleUpdate(id: string): Promise<void> {
	actionInProgress = `update:${id}`;
	editError = null;

	try {
		await client.updateRssFeed(id, {
			url: editUrl || undefined,
			description: editDescription || undefined,
			prompt: editPrompt || undefined,
			poll_interval_seconds: editInterval,
			model_hint: editModel || null,
			no_history: editNoHistory,
		});

		await loadFeeds();

		const updated = feeds.find((f) => f.id === id);
		if (updated) {
			selectedFeed = updated;
		}
	} catch (err: unknown) {
		console.error("Failed to update RSS feed:", err);
		editError = err instanceof Error ? err.message : "Failed to update RSS feed. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

function handleSelectFeed(feed: RssFeedListEntry): void {
	selectedFeed = feed;
	editUrl = feed.url;
	editDescription = feed.description ?? "";
	editPrompt = feed.prompt ?? "";
	editInterval = feed.poll_interval_seconds;
	editModel = feed.model_hint ?? "";
	editNoHistory = feed.no_history === true;
	editError = null;
	view = "detail";
}

function handleBackToList(): void {
	view = "list";
	selectedFeed = null;
	editUrl = "";
	editDescription = "";
	editPrompt = "";
	editInterval = 900;
	editModel = "";
	editNoHistory = false;
	editError = null;
}

function handleCreateNew(): void {
	view = "create";
	createName = "";
	createUrl = "";
	createDescription = "";
	createPrompt = "";
	createInterval = 900;
	createModel = "";
	createNoHistory = false;
	createError = null;
}

function formatInterval(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	} catch {
		return iso;
	}
}
</script>

<Page>
	{#snippet children()}
		<SectionHeader
			number={6}
			subtitle="Polled feed subscriptions"
			title="RSS Feeds"
		>
			{#snippet actions()}
				<TicketTab color="var(--accent)">
					{#snippet children()}{feeds.length} active{/snippet}
				</TicketTab>
			{/snippet}
		</SectionHeader>

		{#if error}
			<div class="error-banner">
				<p>{error}</p>
				<button class="dismiss-btn" onclick={() => (error = null)}>×</button>
			</div>
		{/if}

		{#if loading}
			<div class="state">
				<p>Loading RSS feeds…</p>
			</div>
		{:else if view === "list"}
			<div class="list-view">
				<div class="list-header">
					<h2 class="section-title">RSS Feeds · {feeds.length}</h2>
					<div class="spacer"></div>
					<Btn
						variant="accent"
						size="sm"
						onclick={handleCreateNew}
					>
						{#snippet children()}New Feed{/snippet}
					</Btn>
				</div>

				{#if feeds.length === 0}
					<div class="empty">No RSS feeds configured yet.</div>
				{:else}
					<DataTable
						{columns}
						rows={feeds.map((f) => ({
							...f,
							interval: formatInterval(f.poll_interval_seconds),
							created_at: formatDate(f.created_at),
						}))}
						onRowClick={(row) => {
							const feed = feeds.find((f) => f.id === row.id);
							if (feed) handleSelectFeed(feed);
						}}
					/>
				{/if}
			</div>
		{:else if view === "create"}
			<div class="form-view">
				<div class="form-header">
					<h2 class="section-title">Create RSS Feed</h2>
					<button
						class="back-btn"
						onclick={handleBackToList}
						aria-label="Back to list"
					>
						← Back
					</button>
				</div>

				{#if createError}
					<div class="error-box">
						<p>{createError}</p>
					</div>
				{/if}

				<form
					onsubmit={(e) => {
						e.preventDefault();
						handleCreate();
					}}
					class="feed-form"
				>
					<div class="form-group">
						<label for="name">Name *</label>
						<input
							id="name"
							type="text"
							bind:value={createName}
							placeholder="e.g., hn-frontpage"
							disabled={actionInProgress === "create"}
							required
						/>
						<p class="help-text">
							Lowercase identifier (a-z, 0-9, dashes, underscores). Used as the routing
							key for the feed's event task.
						</p>
					</div>

					<div class="form-group">
						<label for="url">Feed URL *</label>
						<input
							id="url"
							type="url"
							bind:value={createUrl}
							placeholder="https://example.com/feed.xml"
							disabled={actionInProgress === "create"}
							required
						/>
					</div>

					<div class="form-group">
						<label for="interval">Poll interval (seconds)</label>
						<input
							id="interval"
							type="number"
							min="60"
							step="60"
							bind:value={createInterval}
							disabled={actionInProgress === "create"}
						/>
						<p class="help-text">Minimum 60s. Default 900s (15 minutes).</p>
					</div>

					<div class="form-group">
						<label for="description">Description</label>
						<input
							id="description"
							type="text"
							bind:value={createDescription}
							placeholder="e.g., Release announcements"
							disabled={actionInProgress === "create"}
						/>
					</div>

					<div class="form-group">
						<label for="create-model">Model</label>
						<select
							id="create-model"
							bind:value={createModel}
							disabled={actionInProgress === "create"}
						>
							<option value=""
								>Cluster default{defaultModel ? ` (${defaultModel})` : ""}</option
							>
							{#each availableModels as m (`${m.host}/${m.id}`)}
								<option value={m.id}
									>{m.id}{m.via === "relay" ? ` — ${m.host}` : ""}{m.status ===
									"offline?"
										? " (offline?)"
										: ""}</option
								>
							{/each}
						</select>
					</div>

					<div class="form-group">
						<label for="prompt">Custom Prompt</label>
						<textarea
							id="prompt"
							bind:value={createPrompt}
							placeholder="Instructions for handling new items from this feed (optional)"
							rows={4}
							disabled={actionInProgress === "create"}
						></textarea>
					</div>

					<div class="form-group checkbox-group">
						<label for="create-no-history">
							<input
								id="create-no-history"
								type="checkbox"
								bind:checked={createNoHistory}
								disabled={actionInProgress === "create"}
							/>
							Disable history (no_history)
						</label>
						<p class="help-text">
							When enabled, each delivery starts from a clean context window. Saves
							tokens for stateless handlers.
						</p>
					</div>

					<div class="form-actions">
						<Btn
							variant="accent"
							type="submit"
							disabled={actionInProgress === "create" ||
								!createName.trim() ||
								!createUrl.trim()}
						>
							{#snippet children()}
								{actionInProgress === "create" ? "Creating…" : "Create"}
							{/snippet}
						</Btn>
						<Btn
							variant="default"
							type="button"
							disabled={actionInProgress === "create"}
							onclick={handleBackToList}
						>
							{#snippet children()}Cancel{/snippet}
						</Btn>
					</div>
				</form>
			</div>
		{:else if view === "detail" && selectedFeed}
			<div class="detail-view">
				<div class="detail-header">
					<h2 class="section-title">{selectedFeed.name}</h2>
					<button
						class="back-btn"
						onclick={handleBackToList}
						aria-label="Back to list"
					>
						← Back
					</button>
				</div>

				{#if editError}
					<div class="error-box">
						<p>{editError}</p>
					</div>
				{/if}

				<div class="detail-content">
					<div class="detail-section">
						<div class="section-label">Feed ID</div>
						<code class="mono-text">{selectedFeed.id}</code>
					</div>

					{#if selectedFeed.task_id}
						<div class="detail-section">
							<div class="section-label">Associated Task</div>
							<TaskCard taskId={selectedFeed.task_id} />
						</div>
					{/if}

					<div class="detail-section">
						<div class="section-label">Created</div>
						<p>{formatDate(selectedFeed.created_at)}</p>
					</div>

					<div class="detail-section">
						<div class="section-label">Last Modified</div>
						<p>{formatDate(selectedFeed.modified_at)}</p>
					</div>

					<form
						onsubmit={(e) => {
							e.preventDefault();
							handleUpdate(selectedFeed!.id);
						}}
						class="feed-form"
					>
						<div class="form-group">
							<label for="edit-url">Feed URL</label>
							<input
								id="edit-url"
								type="url"
								bind:value={editUrl}
								placeholder="https://example.com/feed.xml"
								disabled={actionInProgress !== null}
							/>
							<p class="help-text">
								Changing the URL resets the feed's seen-items cursor — the next
								poll seeds from the new feed without delivering its backlog.
							</p>
						</div>

						<div class="form-group">
							<label for="edit-interval">Poll interval (seconds)</label>
							<input
								id="edit-interval"
								type="number"
								min="60"
								step="60"
								bind:value={editInterval}
								disabled={actionInProgress !== null}
							/>
						</div>

						<div class="form-group">
							<label for="edit-description">Description</label>
							<input
								id="edit-description"
								type="text"
								bind:value={editDescription}
								placeholder="e.g., Release announcements"
								disabled={actionInProgress !== null}
							/>
						</div>

						<div class="form-group">
							<label for="edit-model">Model</label>
							<select
								id="edit-model"
								bind:value={editModel}
								disabled={actionInProgress !== null}
							>
								<option value=""
									>Cluster default{defaultModel
										? ` (${defaultModel})`
										: ""}</option
								>
								{#each availableModels as m (`${m.host}/${m.id}`)}
									<option value={m.id}
										>{m.id}{m.via === "relay" ? ` — ${m.host}` : ""}{m.status ===
										"offline?"
											? " (offline?)"
											: ""}</option
									>
								{/each}
							</select>
						</div>

						<div class="form-group">
							<label for="edit-prompt">Custom Prompt</label>
							<textarea
								id="edit-prompt"
								bind:value={editPrompt}
								placeholder="Instructions for handling new items from this feed (optional)"
								rows={4}
								disabled={actionInProgress !== null}
							></textarea>
						</div>

						<div class="form-group checkbox-group">
							<label for="edit-no-history">
								<input
									id="edit-no-history"
									type="checkbox"
									bind:checked={editNoHistory}
									disabled={actionInProgress !== null}
								/>
								Disable history (no_history)
							</label>
							<p class="help-text">
								When enabled, each delivery starts from a clean context window.
							</p>
						</div>

						<div class="form-actions">
							<Btn
								variant="accent"
								type="submit"
								disabled={actionInProgress !== null}
							>
								{#snippet children()}
									{actionInProgress?.startsWith("update:")
										? "Saving…"
										: "Save"}
								{/snippet}
							</Btn>
							<Btn
								variant="default"
								type="button"
								disabled={actionInProgress !== null}
								onclick={() => {
									editUrl = selectedFeed?.url ?? "";
									editDescription = selectedFeed?.description ?? "";
									editPrompt = selectedFeed?.prompt ?? "";
									editInterval = selectedFeed?.poll_interval_seconds ?? 900;
									editModel = selectedFeed?.model_hint ?? "";
									editNoHistory = selectedFeed?.no_history === true;
									editError = null;
								}}
							>
								{#snippet children()}Reset{/snippet}
							</Btn>
						</div>
					</form>

					<div class="action-section">
						<Btn
							variant="ghost"
							size="sm"
							disabled={actionInProgress?.startsWith("delete:") ?? false}
							onclick={() =>
								handleDelete(selectedFeed!.id)}
						>
							{#snippet children()}
								{actionInProgress?.startsWith("delete:")
									? "Deleting…"
									: "Delete"}
							{/snippet}
						</Btn>
					</div>
				</div>
			</div>
		{/if}
	{/snippet}
</Page>

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.error-banner {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: var(--err);
		color: white;
		margin-bottom: 16px;
	}

	.error-banner p {
		margin: 0;
		font-size: 13px;
	}

	.dismiss-btn {
		background: none;
		border: none;
		color: white;
		cursor: pointer;
		font-size: 20px;
		padding: 0;
		line-height: 1;
		margin-left: auto;
	}

	.error-box {
		padding: 12px 16px;
		background: rgba(184, 40, 23, 0.1);
		border: 1px solid var(--err);
		color: var(--err);
		margin-bottom: 16px;
		font-size: 13px;
	}

	.list-view {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.list-header {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin: 2px 0 12px 0;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.section-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.005em;
		color: var(--ink);
	}

	.spacer {
		flex: 1;
	}

	.empty {
		padding: 32px;
		text-align: center;
		color: var(--ink-3);
		font-style: italic;
	}

	.form-view,
	.detail-view {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.form-header,
	.detail-header {
		display: flex;
		align-items: baseline;
		gap: 16px;
		margin: 2px 0 12px 0;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.back-btn {
		background: none;
		border: none;
		color: var(--ink-2);
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 13px;
		font-weight: 600;
		padding: 0;
		margin-left: auto;
		transition: color 0.15s ease;
	}

	.back-btn:hover {
		color: var(--accent);
	}

	.feed-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 600px;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.form-group label {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.form-group input,
	.form-group select,
	.form-group textarea {
		padding: 8px 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		color: var(--ink);
		font-family: var(--font-display);
		font-size: 13px;
	}

	.form-group input:focus,
	.form-group select:focus,
	.form-group textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.form-group input:disabled,
	.form-group select:disabled,
	.form-group textarea:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.form-group textarea {
		font-family: var(--font-mono);
		font-size: 12px;
		resize: vertical;
	}

	.form-actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}

	.checkbox-group label {
		display: flex;
		align-items: center;
		gap: 8px;
		text-transform: none;
		letter-spacing: normal;
		font-size: 13px;
		font-weight: 400;
		color: var(--ink);
	}

	.checkbox-group input[type="checkbox"] {
		width: auto;
		padding: 0;
	}

	.help-text {
		margin: 4px 0 0 0;
		font-size: 12px;
		color: var(--ink-3);
		line-height: 1.4;
	}

	.checkbox-group .help-text {
		margin-left: 24px;
	}

	.detail-content {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.detail-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.section-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.mono-text {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink-2);
		word-break: break-all;
	}

	.detail-section p {
		margin: 0;
		font-size: 13px;
		color: var(--ink);
	}

	.action-section {
		display: flex;
		gap: 8px;
		padding-top: 16px;
		border-top: 1px dashed var(--rule-soft);
		margin-top: 16px;
	}
</style>
