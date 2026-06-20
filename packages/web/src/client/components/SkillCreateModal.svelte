<script lang="ts">
import { client } from "../lib/bound";
import Btn from "./Btn.svelte";

interface Props {
	onClose: () => void;
	onCreated: () => void;
}
let { onClose, onCreated }: Props = $props();

let mode = $state<"form" | "upload">("form");
let submitting = $state(false);
let serverError = $state<string | null>(null);

// Form state
let name = $state("");
let description = $state("");
let body = $state("");
let allowedTools = $state("");
let compatibility = $state("");
let showAdvanced = $state(false);

// Validation constants
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

// Form validation
const nameError = $derived(
	name.length === 0
		? null
		: name.length > MAX_NAME_LENGTH
			? "Name must be 64 characters or fewer"
			: !SKILL_NAME_REGEX.test(name)
				? "Name must be lowercase alphanumeric with hyphens only (e.g., my-skill-name)"
				: null,
);

const descriptionError = $derived(
	description.length === 0
		? null
		: description.length > MAX_DESCRIPTION_LENGTH
			? `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`
			: null,
);

const formValid = $derived(
	name.length > 0 && !nameError && description.length > 0 && !descriptionError && body.length > 0,
);

// Upload state
let selectedFile = $state<File | null>(null);
let fileInputEl = $state<HTMLInputElement>();

// Upload validation
const uploadValid = $derived(
	selectedFile !== null &&
		(selectedFile.name.endsWith(".md") || selectedFile.name.endsWith(".zip")),
);

const uploadError = $derived(
	selectedFile && !selectedFile.name.endsWith(".md") && !selectedFile.name.endsWith(".zip")
		? "Only .md and .zip files are accepted"
		: null,
);

function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") {
		onClose();
	}
}

function switchMode(newMode: "form" | "upload"): void {
	mode = newMode;
	serverError = null;
	if (newMode === "form") {
		selectedFile = null;
	} else {
		name = "";
		description = "";
		body = "";
		allowedTools = "";
		compatibility = "";
	}
}

async function submitForm(): Promise<void> {
	if (!formValid || submitting) return;
	submitting = true;
	serverError = null;
	try {
		await client.createSkill({
			name,
			description,
			body,
			allowed_tools: allowedTools || undefined,
			compatibility: compatibility || undefined,
		});
		onCreated();
	} catch (error) {
		serverError = error instanceof Error ? error.message : "Failed to create skill";
	}
	submitting = false;
}

async function submitUpload(): Promise<void> {
	if (!uploadValid || submitting || !selectedFile) return;
	submitting = true;
	serverError = null;
	try {
		const formData = new FormData();
		formData.append("skillfile", selectedFile);
		await client.createSkill(formData);
		onCreated();
	} catch (error) {
		serverError = error instanceof Error ? error.message : "Failed to upload skill";
	}
	submitting = false;
}
</script>

<div class="modal-backdrop" onclick={onClose} onkeydown={handleKeydown} role="presentation">
	<div
		class="modal-panel"
		role="dialog"
		aria-modal="true"
		aria-label="Create Skill"
		tabindex="-1"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<header class="modal-header">
			<h2>Create Skill</h2>
			<div class="mode-tabs">
				<button class:active={mode === "form"} onclick={() => { switchMode("form"); }}>Form</button>
				<button class:active={mode === "upload"} onclick={() => { switchMode("upload"); }}>Upload</button>
			</div>
		</header>

		<div class="modal-body">
			{#if mode === "form"}
				<div class="form-group">
					<label for="skill-name">Name</label>
					<input id="skill-name" type="text" bind:value={name} placeholder="my-skill-name" />
					{#if nameError}
						<span class="field-error">{nameError}</span>
					{/if}
				</div>

				<div class="form-group">
					<label for="skill-desc">Description</label>
					<input id="skill-desc" type="text" bind:value={description} placeholder="What this skill does" />
					<span class="char-count" class:over={description.length > MAX_DESCRIPTION_LENGTH}>
						{description.length}/{MAX_DESCRIPTION_LENGTH}
					</span>
					{#if descriptionError}
						<span class="field-error">{descriptionError}</span>
					{/if}
				</div>

				<div class="form-group">
					<label for="skill-body">Body (Markdown)</label>
					<textarea id="skill-body" bind:value={body} rows={10} placeholder="Skill instructions..."></textarea>
				</div>

				<button class="advanced-toggle" onclick={() => { showAdvanced = !showAdvanced; }}>
					{showAdvanced ? "▼" : "▶"} Advanced
				</button>

				{#if showAdvanced}
					<div class="form-group">
						<label for="skill-tools">Allowed Tools (comma-separated)</label>
						<input id="skill-tools" type="text" bind:value={allowedTools} placeholder="tool1, tool2" />
					</div>
					<div class="form-group">
						<label for="skill-compat">Compatibility</label>
						<input id="skill-compat" type="text" bind:value={compatibility} placeholder="e.g., model >= opus-4" />
					</div>
				{/if}

				{#if serverError}
					<div class="server-error">{serverError}</div>
				{/if}
			{:else}
				<div class="upload-area">
					<label class="file-label">
						<span class="file-label-text">
							{selectedFile ? selectedFile.name : "Choose a .md or .zip file"}
						</span>
						<input
							type="file"
							accept=".md,.zip"
							class="file-input"
							bind:this={fileInputEl}
							onchange={(e) => {
								const input = e.currentTarget as HTMLInputElement;
								selectedFile = input.files?.[0] ?? null;
							}}
						/>
						<Btn variant="default" size="sm" onclick={() => fileInputEl?.click()}>
							{#snippet children()}Browse{/snippet}
						</Btn>
					</label>
					{#if uploadError}
						<span class="field-error">{uploadError}</span>
					{/if}
					{#if selectedFile}
						<div class="file-info">
							<span class="mono">{selectedFile.name}</span>
							<span class="file-size">({(selectedFile.size / 1024).toFixed(1)} KB)</span>
						</div>
					{/if}
				</div>

				{#if serverError}
					<div class="server-error">{serverError}</div>
				{/if}
			{/if}
		</div>

		<div class="modal-footer">
			<Btn variant="default" onclick={onClose}>
				{#snippet children()}Cancel{/snippet}
			</Btn>
			<Btn
				variant="primary"
				disabled={(mode === "form" ? !formValid : !uploadValid) || submitting}
				onclick={mode === "form" ? submitForm : submitUpload}
			>
				{#snippet children()}{submitting ? "Creating..." : "Create"}{/snippet}
			</Btn>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(26, 24, 20, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.modal-panel {
		position: relative;
		z-index: 1;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 0;
		max-width: 640px;
		width: 90%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 30px 60px rgba(0, 0, 0, 0.25);
	}

	.modal-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--rule-soft);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0 0 12px 0;
		font-family: var(--font-header);
		font-size: 18px;
		font-weight: 600;
		color: var(--ink);
	}

	.mode-tabs {
		display: flex;
		gap: 8px;
	}

	.mode-tabs button {
		padding: 6px 12px;
		background: transparent;
		border: 1px solid var(--rule-soft);
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 0;
		transition: background 0.2s, border-color 0.2s;
	}

	.mode-tabs button:hover {
		background: var(--paper-2);
	}

	.mode-tabs button.active {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}

	.modal-body {
		padding: 20px;
		overflow-y: auto;
		max-height: 60vh;
		flex: 1;
		min-height: 0;
	}

	.modal-footer {
		padding: 12px 20px;
		border-top: 1px solid var(--rule-soft);
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		flex-shrink: 0;
	}

	.form-group {
		margin-bottom: 16px;
	}

	.form-group label {
		display: block;
		font-size: var(--text-sm);
		color: var(--ink-3);
		margin-bottom: 4px;
	}

	.form-group input,
	.form-group textarea {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--rule-soft);
		background: var(--paper);
		color: var(--ink);
		font-family: var(--font-body);
		border-radius: 0;
		font-size: var(--text-base);
	}

	.form-group textarea {
		font-family: var(--font-mono);
		resize: vertical;
	}

	.field-error {
		display: block;
		color: var(--err);
		font-size: var(--text-xs);
		margin-top: 2px;
	}

	.char-count {
		font-size: var(--text-xs);
		color: var(--ink-4);
		float: right;
	}

	.char-count.over {
		color: var(--err);
	}

	.server-error {
		padding: 8px 12px;
		background: rgba(184, 40, 23, 0.1);
		color: var(--err);
		border-radius: 0;
		margin-top: 12px;
		font-size: var(--text-sm);
	}

	.advanced-toggle {
		background: none;
		border: none;
		color: var(--ink-3);
		cursor: pointer;
		font-size: var(--text-sm);
		padding: 4px 0;
		margin-bottom: 8px;
	}

	.upload-area {
		padding: 20px;
		border: 2px dashed var(--rule-soft);
		border-radius: 0;
		text-align: center;
	}

	.file-label {
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
	}

	.file-label-text {
		color: var(--ink-3);
		font-size: var(--text-sm);
	}

	.file-input {
		display: none;
	}

	.file-info {
		margin-top: 12px;
		font-size: var(--text-sm);
	}

	.file-size {
		color: var(--ink-4);
	}

	.mono {
		font-family: var(--font-mono);
	}
</style>
