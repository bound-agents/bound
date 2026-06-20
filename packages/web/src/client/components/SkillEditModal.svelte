<script lang="ts">
import type { Skill } from "@bound/shared";
import { untrack } from "svelte";
import { client } from "../lib/bound";
import Btn from "./Btn.svelte";

interface Props {
	skill: Skill;
	content: string;
	onClose: () => void;
	onSaved: () => void;
}
let { skill, content, onClose, onSaved }: Props = $props();

// Parse frontmatter to extract body for pre-filling the editor.
// Format: ---\nkey: value\n---\nbody content
function parseSkillBody(raw: string): string {
	const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) return raw;
	return match[1] ?? "";
}

let description = $state(untrack(() => skill.description ?? ""));
let body = $state(untrack(() => parseSkillBody(content)));
let allowedTools = $state(untrack(() => skill.allowed_tools ?? ""));
let compatibility = $state(untrack(() => skill.compatibility ?? ""));
let showAdvanced = $state(untrack(() => Boolean(skill.allowed_tools || skill.compatibility)));

let submitting = $state(false);
let serverError = $state<string | null>(null);

// Validation (mirrors SkillCreateModal)
const MAX_DESCRIPTION_LENGTH = 1024;

const descriptionError = $derived(
	description.length === 0
		? null
		: description.length > MAX_DESCRIPTION_LENGTH
			? `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`
			: null,
);

const formValid = $derived(description.length > 0 && !descriptionError && body.length > 0);

function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") onClose();
}

async function submitEdit(): Promise<void> {
	if (!formValid || submitting) return;
	submitting = true;
	serverError = null;
	try {
		await client.updateSkill(skill.id, {
			description,
			body,
			allowed_tools: allowedTools || undefined,
			compatibility: compatibility || undefined,
		});
		onSaved();
	} catch (error) {
		serverError = error instanceof Error ? error.message : "Failed to update skill";
	}
	submitting = false;
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="modal-backdrop" onclick={onClose} onkeydown={handleKeydown} role="presentation">
	<div
		class="modal-panel"
		role="dialog"
		aria-modal="true"
		aria-label="Edit Skill"
		tabindex="-1"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<header class="modal-header">
			<h2>Edit Skill</h2>
			<div class="skill-name-badge">{skill.name}</div>
		</header>

		<div class="modal-body">
			<div class="form-group">
				<label for="edit-desc">Description</label>
				<input id="edit-desc" type="text" bind:value={description} placeholder="What this skill does" />
				<span class="char-count" class:over={description.length > MAX_DESCRIPTION_LENGTH}>
					{description.length}/{MAX_DESCRIPTION_LENGTH}
				</span>
				{#if descriptionError}
					<span class="field-error">{descriptionError}</span>
				{/if}
			</div>

			<div class="form-group">
				<label for="edit-body">Body (Markdown)</label>
				<textarea id="edit-body" bind:value={body} rows={12} placeholder="Skill instructions..."></textarea>
			</div>

			<button class="advanced-toggle" onclick={() => { showAdvanced = !showAdvanced; }}>
				{showAdvanced ? "▼" : "▶"} Advanced
			</button>

			{#if showAdvanced}
				<div class="form-group">
					<label for="edit-tools">Allowed Tools (comma-separated)</label>
					<input id="edit-tools" type="text" bind:value={allowedTools} placeholder="tool1, tool2" />
				</div>
				<div class="form-group">
					<label for="edit-compat">Compatibility</label>
					<input id="edit-compat" type="text" bind:value={compatibility} placeholder="e.g., model >= opus-4" />
				</div>
			{/if}

			{#if serverError}
				<div class="server-error">{serverError}</div>
			{/if}
		</div>

		<div class="modal-footer">
			<Btn variant="default" onclick={onClose}>
				{#snippet children()}Cancel{/snippet}
			</Btn>
			<Btn
				variant="primary"
				disabled={!formValid || submitting}
				onclick={submitEdit}
			>
				{#snippet children()}{submitting ? "Saving..." : "Save"}{/snippet}
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
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.modal-header h2 {
		margin: 0;
		font-family: var(--font-header);
		font-size: 18px;
		font-weight: 600;
		color: var(--ink);
	}

	.skill-name-badge {
		font-family: var(--font-mono);
		font-size: 13px;
		color: var(--text-dim);
		background: var(--paper-2);
		padding: 2px 8px;
		border: 1px solid var(--rule-soft);
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
</style>
