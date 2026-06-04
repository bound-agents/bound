<script lang="ts">
import type { Skill } from "@bound/shared";
import { onDestroy, onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import DataTable from "../components/DataTable.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
import SkillCreateModal from "../components/SkillCreateModal.svelte";
import SkillEditModal from "../components/SkillEditModal.svelte";
import StatusChip from "../components/StatusChip.svelte";
import { client } from "../lib/bound";
import { renderMarkdown } from "../lib/markdown";
import { mermaid } from "../lib/mermaid";

let skills: Skill[] = $state([]);
let loading = $state(true);
let statusFilter = $state<"all" | "active" | "retired">("all");
let expandedId = $state<string | null>(null);
let pollInterval: ReturnType<typeof setInterval> | null = null;
let showCreateModal = $state(false);
let showEditModal = $state(false);
let editingSkillId = $state<string | null>(null);

let skillDetail = $state<
	Record<string, { content: string; files: { path: string; size: number }[] } | null>
>({});
let renderedContent = $state<Record<string, string>>({});
let contentLoading = $state<string | null>(null);

let actionInProgress = $state<string | null>(null);
let retireReason = $state<Record<string, string>>({});
let showRetireInput = $state<Record<string, boolean>>({});

const filteredSkills = $derived(
	statusFilter === "all" ? skills : skills.filter((s) => s.status === statusFilter),
);

const columns = [
	{ key: "name", label: "Name", width: "200px", sortable: true },
	{ key: "status", label: "Status", width: "100px", sortable: true },
	{ key: "description", label: "Description", width: "1fr" },
	{ key: "last_activated_at", label: "Last Activated", width: "180px", sortable: true },
];

async function loadSkills(): Promise<void> {
	try {
		skills = await client.listSkills();
	} catch (error) {
		console.error("Failed to load skills:", error);
	}
	loading = false;
}

async function loadSkillDetail(id: string): Promise<void> {
	if (skillDetail[id]) return; // already loaded
	contentLoading = id;
	try {
		const detail = await client.getSkill(id);
		skillDetail = { ...skillDetail, [id]: { content: detail.content, files: detail.files } };
		// Render markdown
		const html = await renderMarkdown(detail.content);
		renderedContent = { ...renderedContent, [id]: html };
	} catch (error) {
		console.error("Failed to load skill detail:", error);
	}
	contentLoading = null;
}

async function retireSkill(id: string): Promise<void> {
	actionInProgress = `${id}:retire`;
	try {
		await client.retireSkill(id, retireReason[id] || undefined);
		retireReason = { ...retireReason, [id]: "" };
		showRetireInput = { ...showRetireInput, [id]: false };
		await loadSkills();
	} catch (error) {
		console.error("Failed to retire skill:", error);
	}
	actionInProgress = null;
}

async function activateSkill(id: string): Promise<void> {
	actionInProgress = `${id}:activate`;
	try {
		await client.activateSkill(id);
		// Clear cached detail so it reloads with fresh data
		const newDetail = { ...skillDetail };
		delete newDetail[id];
		skillDetail = newDetail;
		await loadSkills();
	} catch (error) {
		console.error("Failed to activate skill:", error);
	}
	actionInProgress = null;
}

async function openEditModal(id: string): Promise<void> {
	// Ensure detail is loaded before opening the modal
	if (!skillDetail[id]) {
		await loadSkillDetail(id);
	}
	editingSkillId = id;
	showEditModal = true;
}

function onEditSaved(): void {
	const savedId = editingSkillId;
	showEditModal = false;
	editingSkillId = null;
	if (savedId) {
		// Clear cached detail so it reloads with fresh data
		const newDetail = { ...skillDetail };
		delete newDetail[savedId];
		skillDetail = newDetail;
		const newRendered = { ...renderedContent };
		delete newRendered[savedId];
		renderedContent = newRendered;
	}
	loadSkills();
}

function getRowAccent(row: Record<string, unknown>): string | null {
	if (row.status === "active") return "var(--ok)";
	if (row.status === "retired") return "var(--text-dim)";
	return null;
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Math.round((bytes / k ** i) * 10) / 10} ${sizes[i]}`;
}

onMount(() => {
	loadSkills();
	pollInterval = setInterval(loadSkills, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});

// When a row is expanded, load its detail
$effect.pre(() => {
	if (expandedId && !skillDetail[expandedId]) {
		loadSkillDetail(expandedId);
	}
});
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={6} title="Skills">
			{#snippet actions()}
				<Btn variant="primary" size="sm" onclick={() => { showCreateModal = true; }}>
					{#snippet children()}Create Skill{/snippet}
				</Btn>
			{/snippet}
		</SectionHeader>

		{#if loading}
			<div class="state">
				<p>Loading skills…</p>
			</div>
		{:else}
			<div class="filter-bar">
				<button
					class="filter-btn"
					class:active={statusFilter === "all"}
					onclick={() => (statusFilter = "all")}
				>
					All
				</button>
				<button
					class="filter-btn"
					class:active={statusFilter === "active"}
					onclick={() => (statusFilter = "active")}
				>
					Active
				</button>
				<button
					class="filter-btn"
					class:active={statusFilter === "retired"}
					onclick={() => (statusFilter = "retired")}
				>
					Retired
				</button>
			</div>

			{#if filteredSkills.length === 0}
				<div class="state">
					<p>No skills found.</p>
				</div>
			{:else}
				<DataTable
					{columns}
					rows={filteredSkills}
					expandable={true}
					sortable={true}
					rowAccent={getRowAccent}
					onRowClick={(row) => {
						const id = String(row.id ?? "");
						if (expandedId === id) {
							expandedId = null;
						} else {
							expandedId = id;
						}
					}}
					expandedContent={snippet_content}
				/>
			{/if}
		{/if}
	{/snippet}
</Page>

{#if showCreateModal}
	<SkillCreateModal
		onClose={() => { showCreateModal = false; }}
		onCreated={() => { showCreateModal = false; loadSkills(); }}
	/>
{/if}

{#if showEditModal && editingSkillId}
	{@const editSkill = skills.find((s) => s.id === editingSkillId)}
	{@const editDetail = skillDetail[editingSkillId]}
	{#if editSkill && editDetail}
		<SkillEditModal
			skill={editSkill}
			content={editDetail.content}
			onClose={() => { showEditModal = false; editingSkillId = null; }}
			onSaved={onEditSaved}
		/>
	{/if}
{/if}

{#snippet snippet_content(skill)}
	{@const detail = skillDetail[skill.id as string]}
	{@const content = renderedContent[skill.id as string]}
	{@const isLoading = contentLoading === (skill.id as string)}
	<div class="skill-detail">
		<div class="skill-meta">
			<dt>Status</dt>
			<dd><StatusChip status={skill.status} /></dd>
			<dt>Tools</dt>
			<dd>{skill.allowed_tools || "—"}</dd>
			<dt>Compatibility</dt>
			<dd>{skill.compatibility || "—"}</dd>
			<dt>Activation Count</dt>
			<dd>{skill.activation_count || 0}</dd>
			<dt>Content Hash</dt>
			<dd>{String(skill.content_hash).slice(0, 12)}</dd>
		</div>

		{#if isLoading}
			<div class="loading">Loading content…</div>
		{/if}

		{#if content}
			<div class="skill-content md-content" use:mermaid={content}>{@html content}</div>
		{/if}

		{#if detail?.files && detail.files.length > 0}
			<div class="file-list">
				<div class="kicker">Files</div>
				<ul>
					{#each detail.files as file}
						<li>
							<code>{file.path}</code>
							<span class="size">({formatBytes(file.size)})</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="action-bar">
			<Btn
				size="sm"
				onclick={() => openEditModal(skill.id as string)}
			>
				Edit
			</Btn>
			{#if skill.status === "active"}
				{#if showRetireInput[skill.id as string]}
					<input
						type="text"
						bind:value={retireReason[skill.id as string]}
						placeholder="Reason (optional)"
					/>
					<Btn
						size="sm"
						variant="danger"
						disabled={actionInProgress === `${skill.id}:retire`}
						onclick={() => retireSkill(skill.id as string)}
					>
						Confirm Retire
					</Btn>
				{:else}
					<Btn
						size="sm"
						onclick={() => {
							showRetireInput = { ...showRetireInput, [skill.id as string]: true };
						}}
					>
						Retire
					</Btn>
				{/if}
			{:else if skill.status === "retired"}
				<Btn
					size="sm"
					variant="accent"
					disabled={actionInProgress === `${skill.id}:activate`}
					onclick={() => activateSkill(skill.id as string)}
				>
					Re-activate
				</Btn>
			{/if}
		</div>
	</div>
{/snippet}

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--text-dim);
	}

	.filter-bar {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--rule-soft);
	}

	.filter-btn {
		padding: 6px 12px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 0;
		transition: background 0.2s, border-color 0.2s;
	}

	.filter-btn:hover {
		background: var(--paper-2);
	}

	.filter-btn.active {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}

	.skill-detail {
		padding: 12px 16px;
	}

	.skill-meta {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 12px;
		margin-bottom: 12px;
	}

	.skill-meta dt {
		color: var(--text-dim);
		font-size: 0.85em;
		font-weight: 500;
	}

	.skill-meta dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.85em;
	}

	.loading {
		padding: 12px;
		color: var(--text-dim);
		font-style: italic;
		text-align: center;
	}

	.skill-content {
		margin-top: 12px;
		padding: 12px;
		background: var(--paper-2);
		border-radius: 4px;
	}

	.file-list {
		margin-top: 12px;
	}

	.file-list .kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--text-dim);
		margin-bottom: 6px;
	}

	.file-list ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.file-list li {
		font-family: var(--font-mono);
		font-size: 0.85em;
		color: var(--text-dim);
		margin-bottom: 4px;
		padding-left: 8px;
	}

	.file-list code {
		background: var(--paper-2);
		padding: 2px 4px;
		border-radius: 2px;
		font-size: 0.9em;
	}

	.size {
		color: var(--text-dim);
		font-size: 0.85em;
	}

	.action-bar {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--rule-soft);
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.action-bar input {
		flex: 1;
		padding: 6px 8px;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		color: var(--ink);
		font-family: var(--font-display);
		font-size: 12px;
		border-radius: 0;
	}

	:global(.skill-content h1),
	:global(.skill-content h2),
	:global(.skill-content h3),
	:global(.skill-content h4),
	:global(.skill-content h5),
	:global(.skill-content h6) {
		margin-top: 12px;
		margin-bottom: 8px;
		font-weight: 600;
	}

	:global(.skill-content code) {
		background: var(--paper-2);
		padding: 2px 4px;
		border-radius: 2px;
		font-size: 0.9em;
	}

	:global(.skill-content pre) {
		background: var(--paper-2);
		padding: 8px;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.85em;
		line-height: 1.5;
	}

	:global(.skill-content table) {
		border-collapse: collapse;
		width: 100%;
		margin: 8px 0;
		font-size: 0.9em;
	}

	:global(.skill-content th),
	:global(.skill-content td) {
		border: 1px solid var(--rule-soft);
		padding: 4px 8px;
		text-align: left;
	}

	:global(.skill-content th) {
		background: var(--paper-2);
		font-weight: 600;
	}
</style>
