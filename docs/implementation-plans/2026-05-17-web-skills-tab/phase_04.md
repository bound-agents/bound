# Web Skills Tab — Phase 4: SkillCreateModal

**Goal:** Modal for creating skills via form or file upload, with client-side validation

**Architecture:** A `SkillCreateModal.svelte` component modeled after `FilePreviewModal.svelte` (backdrop, focus trap, escape-to-close). Two modes: "Form" (structured fields assembled into SKILL.md) and "Upload" (single .md or .zip file). Client-side validation provides immediate inline feedback before submission.

**Tech Stack:** Svelte 5, BoundClient.createSkill(), Btn component, existing CSS variables

**Scope:** 5 phases from original design (phase 4 of 5)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### web-skills-tab.AC3: UI provides full skill management (create modal)
- **web-skills-tab.AC3.8 Success:** "Create Skill" button opens SkillCreateModal
- **web-skills-tab.AC3.9 Success:** Form mode creates skill with name, description, body, and optional advanced fields
- **web-skills-tab.AC3.10 Success:** Upload mode (single file) creates skill from .md file
- **web-skills-tab.AC3.11 Success:** Upload mode (zip) creates skill from .zip archive
- **web-skills-tab.AC3.12 Failure:** Invalid form input shows inline validation error before submission

---

<!-- START_TASK_1 -->
### Task 1: Add "Create Skill" button to SkillsView that opens the modal

**Verifies:** web-skills-tab.AC3.8

**Files:**
- Modify: `packages/web/src/client/views/SkillsView.svelte` (add button + modal state)

**Implementation:**

Add state for modal visibility:
```typescript
let showCreateModal = $state(false);
```

Add a "Create Skill" button in the SectionHeader's `actions` snippet:
```svelte
<SectionHeader number={6} title="Skills">
	{#snippet actions()}
		<Btn variant="primary" size="sm" onclick={() => { showCreateModal = true; }}>
			{#snippet children()}Create Skill{/snippet}
		</Btn>
	{/snippet}
</SectionHeader>
```

At the bottom of the component (after the Page closing), render the modal conditionally:
```svelte
{#if showCreateModal}
	<SkillCreateModal
		onClose={() => { showCreateModal = false; }}
		onCreated={() => { showCreateModal = false; loadSkills(); }}
	/>
{/if}
```

Import the modal component:
```typescript
import SkillCreateModal from "../components/SkillCreateModal.svelte";
```

Create a minimal placeholder `SkillCreateModal.svelte` to verify the wiring:
```svelte
<script lang="ts">
	interface Props {
		onClose: () => void;
		onCreated: () => void;
	}
	let { onClose, onCreated }: Props = $props();
</script>

<div class="modal-backdrop">
	<div class="modal-panel">
		<h2>Create Skill</h2>
		<button onclick={onClose}>Close</button>
	</div>
</div>
```

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): add Create Skill button and modal placeholder`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->
<!-- START_TASK_2 -->
### Task 2: Implement SkillCreateModal shell with backdrop, focus trap, and mode toggle

**Files:**
- Modify: `packages/web/src/client/components/SkillCreateModal.svelte` (replace placeholder)

**Implementation:**

Model after `FilePreviewModal.svelte` structure. The modal has:

**Props:**
```typescript
interface Props {
	onClose: () => void;
	onCreated: () => void;
}
```

**State:**
```typescript
let mode = $state<"form" | "upload">("form");
let submitting = $state(false);
let serverError = $state<string | null>(null);
```

**Structure:**
1. **Backdrop** — fixed overlay with `onclick={onClose}` on the backdrop itself (not the panel)
2. **Panel** — centered card with header, body, footer
3. **Header** — "Create Skill" title + mode toggle (two tab buttons: "Form" / "Upload")
4. **Body** — conditional content based on `mode`
5. **Footer** — Cancel + Submit buttons

**Focus trap:** Add `onkeydown` handler on the backdrop element:
```typescript
function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") onClose();
}
```

**Mode toggle UI:**
```svelte
<div class="mode-tabs">
	<button class:active={mode === "form"} onclick={() => { mode = "form"; }}>Form</button>
	<button class:active={mode === "upload"} onclick={() => { mode = "upload"; }}>Upload</button>
</div>
```

**Styling** — follow FilePreviewModal CSS patterns:
- `.modal-backdrop`: fixed inset 0, background rgba(0,0,0,0.4), z-index 100, display flex align/justify center
- `.modal-panel`: background var(--paper), border-radius var(--r-md), box-shadow, max-width 640px, width 90%
- `.modal-header`: padding 16px 20px, border-bottom 1px solid var(--rule-soft)
- `.modal-body`: padding 20px, overflow-y auto, max-height 60vh
- `.modal-footer`: padding 12px 20px, border-top 1px solid var(--rule-soft), display flex justify-content flex-end gap 8px
- `.mode-tabs button`: similar to filter buttons — underline or background change on active

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): implement SkillCreateModal shell with mode toggle`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Implement Form mode with validation

**Verifies:** web-skills-tab.AC3.9, web-skills-tab.AC3.12

**Files:**
- Modify: `packages/web/src/client/components/SkillCreateModal.svelte` (add form mode content)

**Implementation:**

**Form state:**
```typescript
let name = $state("");
let description = $state("");
let body = $state("");
let allowedTools = $state("");
let compatibility = $state("");
let showAdvanced = $state(false);
```

**Validation state (derived):**
```typescript
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

const nameError = $derived(
	name.length === 0 ? null :
	name.length > MAX_NAME_LENGTH ? "Name must be 64 characters or fewer" :
	!SKILL_NAME_REGEX.test(name) ? "Name must be lowercase alphanumeric with hyphens only (e.g., my-skill-name)" :
	null
);

const descriptionError = $derived(
	description.length === 0 ? null :
	description.length > MAX_DESCRIPTION_LENGTH ? `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` :
	null
);

const formValid = $derived(
	name.length > 0 && !nameError &&
	description.length > 0 && !descriptionError &&
	body.length > 0
);
```

**Form template:**
```svelte
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
{/if}
```

**Submit handler for form mode:**
```typescript
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
```

**Footer submit button (disabled when invalid or submitting):**
```svelte
<Btn variant="primary" disabled={!formValid || submitting} onclick={submitForm}>
	{#snippet children()}{submitting ? "Creating..." : "Create"}{/snippet}
</Btn>
```

**Server error display (below form, above footer):**
```svelte
{#if serverError}
	<div class="server-error">{serverError}</div>
{/if}
```

**Styling for form elements:**
```css
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: var(--text-sm); color: var(--ink-3); margin-bottom: 4px; }
.form-group input, .form-group textarea {
	width: 100%; padding: 8px 10px; border: 1px solid var(--rule-soft);
	background: var(--paper); color: var(--ink); font-family: var(--font-body);
	border-radius: var(--r-sm); font-size: var(--text-base);
}
.form-group textarea { font-family: var(--font-mono); resize: vertical; }
.field-error { display: block; color: var(--err); font-size: var(--text-xs); margin-top: 2px; }
.char-count { font-size: var(--text-xs); color: var(--ink-4); float: right; }
.char-count.over { color: var(--err); }
.server-error { padding: 8px 12px; background: rgba(184, 40, 23, 0.1); color: var(--err); border-radius: var(--r-sm); margin-top: 12px; font-size: var(--text-sm); }
.advanced-toggle { background: none; border: none; color: var(--ink-3); cursor: pointer; font-size: var(--text-sm); padding: 4px 0; margin-bottom: 8px; }
```

Import the BoundClient:
```typescript
import { client } from "../lib/bound";
import Btn from "./Btn.svelte";
```

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): implement form mode with inline validation in SkillCreateModal`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement Upload mode (.md and .zip)

**Verifies:** web-skills-tab.AC3.10, web-skills-tab.AC3.11

**Files:**
- Modify: `packages/web/src/client/components/SkillCreateModal.svelte` (add upload mode content)

**Implementation:**

**Upload state:**
```typescript
let selectedFile = $state<File | null>(null);
let fileInputEl: HTMLInputElement;
```

**Upload validation (derived):**
```typescript
const uploadValid = $derived(
	selectedFile !== null &&
	(selectedFile.name.endsWith(".md") || selectedFile.name.endsWith(".zip"))
);

const uploadError = $derived(
	selectedFile && !selectedFile.name.endsWith(".md") && !selectedFile.name.endsWith(".zip")
		? "Only .md and .zip files are accepted"
		: null
);
```

**Upload template:**
```svelte
{#if mode === "upload"}
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
{/if}
```

**Submit handler for upload mode:**
```typescript
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
```

**Footer wiring** — the submit button should call the appropriate handler based on mode:
```svelte
<Btn
	variant="primary"
	disabled={(mode === "form" ? !formValid : !uploadValid) || submitting}
	onclick={mode === "form" ? submitForm : submitUpload}
>
	{#snippet children()}{submitting ? "Creating..." : "Create"}{/snippet}
</Btn>
```

**Upload area styling:**
```css
.upload-area { padding: 20px; border: 2px dashed var(--rule-soft); border-radius: var(--r-md); text-align: center; }
.file-label { cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; }
.file-label-text { color: var(--ink-3); font-size: var(--text-sm); }
.file-input { display: none; }
.file-info { margin-top: 12px; font-size: var(--text-sm); }
.file-size { color: var(--ink-4); }
.mono { font-family: var(--font-mono); }
```

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): implement upload mode in SkillCreateModal`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Clear state on mode switch and modal close

**Files:**
- Modify: `packages/web/src/client/components/SkillCreateModal.svelte` (add reset logic)

**Implementation:**

When switching modes, clear the other mode's state to avoid stale data:
```typescript
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
```

Update mode toggle buttons to use `switchMode()` instead of directly setting `mode`.

This ensures that if a user starts filling the form, switches to upload, and switches back, they don't see stale form content from before (and vice versa). The design doesn't specify preservation of state across mode switches, so clearing is the safest behavior.

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): clear state on mode switch in SkillCreateModal`
<!-- END_TASK_5 -->
