<script lang="ts">
import type { ClusterModelInfo, ConnectorBindingEntry } from "@bound/client";
import { onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import DataTable from "../components/DataTable.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import TaskCard from "../components/TaskCard.svelte";
import TicketTab from "../components/TicketTab.svelte";
import { client } from "../lib/bound";

let bindings: ConnectorBindingEntry[] = $state([]);
let loading = $state(true);
let error = $state<string | null>(null);
let view = $state<"list" | "detail">("list");
let selectedBinding = $state<ConnectorBindingEntry | null>(null);
let actionInProgress = $state<string | null>(null);
let detailError = $state<string | null>(null);

// Cluster model catalogue for the picker. Empty = fall back to cluster default.
let availableModels: ClusterModelInfo[] = $state([]);
let defaultModel = $state("");
// "" means "use the cluster default" — sent as null on PATCH.
let editModel = $state("");

const columns = [
	{ key: "server_name", label: "Server", width: "1fr", mono: true },
	{ key: "event_name", label: "Event", width: "1.5fr", mono: true },
	{ key: "event_args_display", label: "Args", width: "2.2fr", mono: true },
	{ key: "task_status", label: "Task", width: "0.8fr" },
	{ key: "model_display", label: "Model", width: "1fr", mono: true },
	{ key: "created_at", label: "Created", width: "1.2fr" },
];

onMount(() => {
	loadBindings();
	loadModels();
});

async function loadModels(): Promise<void> {
	// Best-effort: the picker still offers "cluster default" if /models fails.
	try {
		const resp = await client.listModels();
		availableModels = resp.models;
		defaultModel = resp.default;
	} catch (err: unknown) {
		console.error("Failed to load models for connector binding dropdown:", err);
	}
}

async function loadBindings(): Promise<void> {
	try {
		loading = true;
		error = null;
		const response = await client.listConnectorBindings();
		bindings = response.bindings;
		if (selectedBinding) {
			const updated = response.bindings.find((b) => b.id === selectedBinding?.id);
			selectedBinding = updated ?? null;
			if (updated) {
				editModel = updated.model_hint ?? "";
			} else {
				view = "list";
			}
		}
	} catch (err: unknown) {
		console.error("Failed to load connector bindings:", err);
		error = err instanceof Error ? err.message : "Failed to load connector bindings.";
	} finally {
		loading = false;
	}
}

function handleSelectBinding(binding: ConnectorBindingEntry): void {
	selectedBinding = binding;
	editModel = binding.model_hint ?? "";
	detailError = null;
	view = "detail";
}

function handleBackToList(): void {
	view = "list";
	selectedBinding = null;
	editModel = "";
	detailError = null;
}

// "" → null clears the override back to the cluster default; the route treats
// both the same, but sending null states the intent explicitly.
async function handleUpdateModel(id: string): Promise<void> {
	actionInProgress = `model:${id}`;
	detailError = null;

	try {
		await client.updateConnectorBinding(id, { model_hint: editModel || null });
		await loadBindings();
	} catch (err: unknown) {
		console.error("Failed to update connector binding model:", err);
		detailError = err instanceof Error ? err.message : "Failed to update the binding's model.";
	} finally {
		actionInProgress = null;
	}
}

async function handleDetach(id: string): Promise<void> {
	if (!confirm("Detach this connector binding? The backing event task will be removed.")) {
		return;
	}

	actionInProgress = `detach:${id}`;
	detailError = null;

	try {
		await client.detachConnectorBinding(id);
		await loadBindings();
		view = "list";
		selectedBinding = null;
	} catch (err: unknown) {
		console.error("Failed to detach connector binding:", err);
		detailError = err instanceof Error ? err.message : "Failed to detach connector binding.";
	} finally {
		actionInProgress = null;
	}
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

function formatDateTime(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function formatArgs(args: unknown): string {
	if (args === null || args === undefined) return "{}";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}
</script>

<Page>
	{#snippet children()}
		<SectionHeader
			number={6}
			subtitle="Platform event subscriptions"
			title="Connector bindings"
		>
			{#snippet actions()}
				<TicketTab color="var(--accent)">
					{#snippet children()}{bindings.length} active{/snippet}
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
				<p>Loading connector bindings…</p>
			</div>
		{:else if view === "list"}
			<div class="list-view">
				<div class="list-header">
					<h2 class="section-title">Connector bindings · {bindings.length}</h2>
					<div class="spacer"></div>
					<Btn variant="default" size="sm" onclick={loadBindings}>
						{#snippet children()}Refresh{/snippet}
					</Btn>
				</div>

				{#if bindings.length === 0}
					<div class="empty">No connector bindings configured yet.</div>
				{:else}
					<DataTable
						{columns}
						rows={bindings.map((binding) => ({
							...binding,
							event_args_display: formatArgs(binding.event_args),
							task_status: binding.task_status ?? "missing",
							model_display: binding.model_hint ?? "default",
							created_at: formatDate(binding.created_at),
						}))}
						onRowClick={(row) => {
							const binding = bindings.find((b) => b.id === row.id);
							if (binding) handleSelectBinding(binding);
						}}
					/>
				{/if}
			</div>
		{:else if view === "detail" && selectedBinding}
			<div class="detail-view">
				<div class="detail-header">
					<h2 class="section-title">
						{selectedBinding.server_name}:{selectedBinding.event_name}
					</h2>
					<button class="back-btn" onclick={handleBackToList} aria-label="Back to list">
						← Back
					</button>
				</div>

				{#if detailError}
					<div class="error-box">
						<p>{detailError}</p>
					</div>
				{/if}

				<div class="detail-content">
					<div class="detail-section">
						<div class="section-label">Handle ID</div>
						<code class="mono-text">{selectedBinding.id}</code>
					</div>

					<div class="detail-grid">
						<div class="detail-section">
							<div class="section-label">Server</div>
							<p>{selectedBinding.server_name}</p>
						</div>
						<div class="detail-section">
							<div class="section-label">Event</div>
							<p>{selectedBinding.event_name}</p>
						</div>
						<div class="detail-section">
							<div class="section-label">Delivery mode</div>
							<p>{selectedBinding.delivery_mode}</p>
						</div>
						<div class="detail-section">
							<div class="section-label">Created</div>
							<p>{formatDateTime(selectedBinding.created_at)}</p>
						</div>
					</div>

					<div class="detail-section">
						<div class="section-label">Event args</div>
						<pre class="args-block">{formatArgs(selectedBinding.event_args)}</pre>
					</div>

					{#if selectedBinding.task_id}
						<div class="detail-section">
							<div class="section-label">Associated Task</div>
							<TaskCard taskId={selectedBinding.task_id} />
						</div>
					{:else}
						<div class="detail-section">
							<div class="section-label">Associated Task</div>
							<p class="muted">No backing task recorded.</p>
						</div>
					{/if}

					<!-- Model lives on the backing event task, so a binding without one
					     has nowhere to record it. Explain rather than offer a dead control. -->
					<div class="detail-section">
						<div class="section-label">Model</div>
						{#if selectedBinding.task_id}
							<div class="model-row">
								<select
									id="binding-model"
									aria-label="Model for this connector binding"
									bind:value={editModel}
									disabled={actionInProgress !== null}
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
								<Btn
									variant="default"
									size="sm"
									disabled={actionInProgress !== null ||
										editModel === (selectedBinding.model_hint ?? "")}
									onclick={() => handleUpdateModel(selectedBinding!.id)}
								>
									{#snippet children()}
										{actionInProgress?.startsWith("model:") ? "Saving…" : "Save"}
									{/snippet}
								</Btn>
							</div>
						{:else}
							<p class="muted">
								No backing task, so no model can be set for this binding.
							</p>
						{/if}
					</div>

					<div class="action-section">
						<Btn
							variant="danger"
							size="sm"
							disabled={actionInProgress?.startsWith("detach:") ?? false}
							onclick={() => handleDetach(selectedBinding!.id)}
						>
							{#snippet children()}
								{actionInProgress?.startsWith("detach:") ? "Detaching…" : "Detach"}
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

	.list-view,
	.detail-view {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.list-header,
	.detail-header {
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

	.detail-content {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 16px;
	}

	.detail-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.detail-section p {
		margin: 0;
		font-size: 13px;
		color: var(--ink-2);
	}

	.section-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.mono-text,
	.args-block {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink);
	}

	.mono-text {
		padding: 4px 6px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		display: inline-block;
		word-break: break-all;
	}

	.args-block {
		margin: 0;
		padding: 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.muted {
		color: var(--ink-3) !important;
		font-style: italic;
	}

	/* Picker + Save sit on one line; the select takes the slack so long model
	   ids (relay entries carry a host suffix) don't clip the button. */
	.model-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.model-row select {
		flex: 1;
		min-width: 0;
		padding: 6px 8px;
		background: var(--paper);
		border: 1px solid var(--rule);
		color: var(--ink);
		font-family: var(--font-mono);
		font-size: 12px;
	}

	.model-row select:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.action-section {
		display: flex;
		gap: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--rule-soft);
	}
</style>
