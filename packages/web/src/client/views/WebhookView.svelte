<script lang="ts">
import type { ClusterModelInfo, WebhookListEntry } from "@bound/client";
import { onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import DataTable from "../components/DataTable.svelte";
import Page from "../components/Page.svelte";
import SecretModal from "../components/SecretModal.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import TicketTab from "../components/TicketTab.svelte";
import { client } from "../lib/bound";
import { getWebhookEndpointUrl } from "../lib/webhook-utils";

let webhooks: WebhookListEntry[] = $state([]);
let loading = $state(true);
let view = $state<"list" | "create" | "detail">("list");
let selectedWebhook = $state<WebhookListEntry | null>(null);
let secretModal = $state<{ secret: string; name: string } | null>(null);
let error = $state<string | null>(null);

// Cluster model catalogue (for dropdowns). Empty = use cluster default.
let availableModels: ClusterModelInfo[] = $state([]);
let defaultModel = $state("");

// Create form state
let createName = $state("");
let createFormat = $state("github");
let createDescription = $state("");
let createPrompt = $state("");
let createModel = $state(""); // "" = use cluster default
let createError = $state<string | null>(null);

// Edit form state
let editDescription = $state("");
let editFormat = $state("");
let editPrompt = $state("");
let editModel = $state(""); // "" = use cluster default
let editError = $state<string | null>(null);

// Loading states
let actionInProgress = $state<string | null>(null);

const columns = [
	{ key: "name", label: "Name", width: "2fr", mono: true },
	{ key: "signature_format", label: "Format", width: "1fr" },
	{ key: "description", label: "Description", width: "3fr" },
	{ key: "created_at", label: "Created", width: "2fr" },
];

onMount(() => {
	loadWebhooks();
	loadModels();
});

async function loadWebhooks(): Promise<void> {
	try {
		loading = true;
		error = null;
		webhooks = await client.listWebhooks();
	} catch (err: unknown) {
		console.error("Failed to load webhooks:", err);
		error = err instanceof Error ? err.message : "Failed to load webhooks. Please try again.";
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
		console.error("Failed to load models for webhook dropdown:", err);
	}
}

async function handleCreate(): Promise<void> {
	if (!createName.trim()) {
		createError = "Name is required";
		return;
	}

	actionInProgress = "create";
	createError = null;

	try {
		const response = await client.createWebhook({
			name: createName,
			format: createFormat,
			description: createDescription || undefined,
			prompt: createPrompt || undefined,
			model_hint: createModel || null,
		});

		// Show secret modal
		secretModal = {
			secret: response.secret,
			name: response.name,
		};

		// Reset form
		createName = "";
		createFormat = "github";
		createDescription = "";
		createPrompt = "";
		createModel = "";

		// Reload webhooks
		await loadWebhooks();

		// Return to list after a short delay
		setTimeout(() => {
			view = "list";
		}, 500);
	} catch (err: unknown) {
		console.error("Failed to create webhook:", err);
		createError =
			err instanceof Error ? err.message : "Failed to create webhook. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

async function handleDelete(id: string): Promise<void> {
	if (!confirm("Are you sure you want to delete this webhook? This action cannot be undone.")) {
		return;
	}

	actionInProgress = `delete:${id}`;

	try {
		await client.deleteWebhook(id);
		await loadWebhooks();
		view = "list";
		selectedWebhook = null;
	} catch (err: unknown) {
		console.error("Failed to delete webhook:", err);
		error = err instanceof Error ? err.message : "Failed to delete webhook. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

async function handleUpdate(id: string): Promise<void> {
	actionInProgress = `update:${id}`;
	editError = null;

	try {
		await client.updateWebhook(id, {
			description: editDescription || undefined,
			format: editFormat,
			prompt: editPrompt || undefined,
			model_hint: editModel || null,
		});

		await loadWebhooks();

		// Update selected webhook
		const updated = webhooks.find((w) => w.id === id);
		if (updated) {
			selectedWebhook = updated;
		}
	} catch (err: unknown) {
		console.error("Failed to update webhook:", err);
		editError = err instanceof Error ? err.message : "Failed to update webhook. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

async function handleRotateSecret(id: string): Promise<void> {
	actionInProgress = `rotate:${id}`;

	try {
		const response = await client.rotateWebhookSecret(id);

		// Show secret modal
		const webhook = webhooks.find((w) => w.id === id);
		if (webhook) {
			secretModal = {
				secret: response.secret,
				name: webhook.name,
			};
		}
	} catch (err: unknown) {
		console.error("Failed to rotate webhook secret:", err);
		editError = err instanceof Error ? err.message : "Failed to rotate secret. Please try again.";
	} finally {
		actionInProgress = null;
	}
}

function handleSelectWebhook(webhook: WebhookListEntry): void {
	selectedWebhook = webhook;
	editDescription = webhook.description ?? "";
	editFormat = webhook.signature_format;
	editPrompt = webhook.prompt ?? "";
	editModel = webhook.model_hint ?? "";
	editError = null;
	view = "detail";
}

function handleBackToList(): void {
	view = "list";
	selectedWebhook = null;
	editDescription = "";
	editFormat = "";
	editPrompt = "";
	editModel = "";
	editError = null;
}

function handleCreateNew(): void {
	view = "create";
	createName = "";
	createFormat = "github";
	createDescription = "";
	createPrompt = "";
	createModel = "";
	createError = null;
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
			subtitle="Automated messaging endpoints"
			title="Webhooks"
		>
			{#snippet actions()}
				<TicketTab color="var(--accent)">
					{#snippet children()}{webhooks.length} active{/snippet}
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
				<p>Loading webhooks…</p>
			</div>
		{:else if view === "list"}
			<div class="list-view">
				<div class="list-header">
					<h2 class="section-title">Webhooks · {webhooks.length}</h2>
					<div class="spacer"></div>
					<Btn
						variant="accent"
						size="sm"
						onclick={handleCreateNew}
					>
						{#snippet children()}New Webhook{/snippet}
					</Btn>
				</div>

				{#if webhooks.length === 0}
					<div class="empty">No webhooks configured yet.</div>
				{:else}
					<DataTable
						{columns}
						rows={webhooks.map((w) => ({
							...w,
							created_at: formatDate(w.created_at),
						}))}
						onRowClick={(row) => {
							const webhook = webhooks.find((w) => w.id === row.id);
							if (webhook) handleSelectWebhook(webhook);
						}}
					/>
				{/if}
			</div>
		{:else if view === "create"}
			<div class="form-view">
				<div class="form-header">
					<h2 class="section-title">Create Webhook</h2>
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
					class="webhook-form"
				>
					<div class="form-group">
						<label for="name">Name *</label>
						<input
							id="name"
							type="text"
							bind:value={createName}
							placeholder="e.g., GitHub Webhook"
							disabled={actionInProgress === "create"}
							required
						/>
					</div>

					<div class="form-group">
						<label for="format">Format</label>
						<select
							id="format"
							bind:value={createFormat}
							disabled={actionInProgress === "create"}
						>
							<option value="github">GitHub</option>
							<option value="generic">Generic JSON</option>
						</select>
					</div>

					<div class="form-group">
						<label for="description">Description</label>
						<input
							id="description"
							type="text"
							bind:value={createDescription}
							placeholder="e.g., Push events from main repo"
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
							placeholder="Instructions for handling events from this webhook (optional)"
							rows={4}
							disabled={actionInProgress === "create"}
						></textarea>
					</div>

					<div class="form-actions">
						<Btn
							variant="accent"
							type="submit"
							disabled={actionInProgress === "create" || !createName.trim()}
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
		{:else if view === "detail" && selectedWebhook}
			<div class="detail-view">
				<div class="detail-header">
					<h2 class="section-title">{selectedWebhook.name}</h2>
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
						<div class="section-label">Webhook ID</div>
						<code class="mono-text">{selectedWebhook.id}</code>
					</div>

					<div class="detail-section">
						<div class="section-label">Endpoint URL</div>
						<code class="mono-text">{getWebhookEndpointUrl(selectedWebhook.id, window.location.origin)}</code>
					</div>

					<div class="detail-section">
						<div class="section-label">Format</div>
						<p>{selectedWebhook.signature_format}</p>
					</div>

					<div class="detail-section">
						<div class="section-label">Created</div>
						<p>{formatDate(selectedWebhook.created_at)}</p>
					</div>

					<div class="detail-section">
						<div class="section-label">Last Modified</div>
						<p>{formatDate(selectedWebhook.modified_at)}</p>
					</div>

					<form
						onsubmit={(e) => {
							e.preventDefault();
							handleUpdate(selectedWebhook!.id);
						}}
						class="webhook-form"
					>
						<div class="form-group">
							<label for="edit-description">Description</label>
							<input
								id="edit-description"
								type="text"
								bind:value={editDescription}
								placeholder="e.g., Push events from main repo"
								disabled={actionInProgress !== null}
							/>
						</div>

						<div class="form-group">
							<label for="edit-format">Format</label>
							<select
								id="edit-format"
								bind:value={editFormat}
								disabled={actionInProgress !== null}
							>
								<option value="github">GitHub</option>
								<option value="generic">Generic JSON</option>
							</select>
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
								placeholder="Instructions for handling events from this webhook (optional)"
								rows={4}
								disabled={actionInProgress !== null}
							></textarea>
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
									editDescription = selectedWebhook?.description ?? "";
									editFormat = selectedWebhook?.signature_format ?? "";
									editPrompt = selectedWebhook?.prompt ?? "";
									editError = null;
								}}
							>
								{#snippet children()}Reset{/snippet}
							</Btn>
						</div>
					</form>

					<div class="action-section">
						<Btn
							variant="default"
							size="sm"
							disabled={actionInProgress?.startsWith("rotate:") ?? false}
							onclick={() =>
								handleRotateSecret(selectedWebhook!.id)}
						>
							{#snippet children()}
								{actionInProgress?.startsWith("rotate:")
									? "Rotating…"
									: "Rotate Secret"}
							{/snippet}
						</Btn>

						<Btn
							variant="ghost"
							size="sm"
							disabled={actionInProgress?.startsWith("delete:") ?? false}
							onclick={() =>
								handleDelete(selectedWebhook!.id)}
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

		{#if secretModal}
			<SecretModal
				secret={secretModal.secret}
				webhookName={secretModal.name}
				onClose={() => (secretModal = null)}
			/>
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

	.webhook-form {
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
