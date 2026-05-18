# Webhook Ingestion Implementation Plan — Phase 6

**Goal:** Full CRUD web interface for webhook management with one-time secret display, plus BoundClient SDK methods.

**Architecture:** BoundClient gains webhook CRUD methods (following the advisory pattern). New `WebhookView.svelte` with DataTable for listing, create form, detail/edit panel, and a one-time secret display modal. Navigation entry added to TopBar and App.svelte hash router. `isUserFacingInterface` updated to filter webhook threads.

**Tech Stack:** Svelte 5 (runes), TypeScript, BoundClient (fetch-based)

**Scope:** 6 phases from original design (this is phase 6 of 6)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### webhook-ingestion.AC6: Web UI (full CRUD)
- **webhook-ingestion.AC6.1 Success:** Webhook list view shows all webhooks with name, format, description, date
- **webhook-ingestion.AC6.2 Success:** Create form produces webhook and displays secret in one-time modal with copy button
- **webhook-ingestion.AC6.3 Success:** Detail view allows editing prompt, description, and format
- **webhook-ingestion.AC6.4 Success:** Rotate secret button shows new secret in one-time modal
- **webhook-ingestion.AC6.5 Success:** Delete button with confirmation soft-deletes webhook
- **webhook-ingestion.AC6.6 Success:** Webhook view accessible from main navigation
- **webhook-ingestion.AC6.7 Edge:** After dismissing secret modal, secret is no longer retrievable from the UI

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add webhook methods to BoundClient

**Verifies:** Supports all AC6 criteria (client SDK underpins UI)

**Files:**
- Modify: `packages/client/src/client.ts` (add methods after existing advisory methods)
- Modify: `packages/client/src/types.ts` (add webhook response types)

**Implementation:**

Add types to `packages/client/src/types.ts`:

```typescript
export interface WebhookListEntry {
	id: string;
	name: string;
	signature_format: string;
	description: string | null;
	task_id: string;
	thread_id: string;
	created_at: string;
	modified_at: string;
}

export interface WebhookCreateResponse extends WebhookListEntry {
	secret: string; // Only present on create
}

export interface WebhookRotateResponse {
	secret: string;
}

export interface CreateWebhookOptions {
	name: string;
	format?: string;
	description?: string;
	prompt?: string;
}

export interface UpdateWebhookOptions {
	description?: string;
	prompt?: string;
	format?: string;
}
```

Add methods to BoundClient class in `packages/client/src/client.ts`:

```typescript
// Webhook CRUD
async listWebhooks(): Promise<WebhookListEntry[]> {
	return this.fetchJson("/api/webhooks");
}

async getWebhook(id: string): Promise<WebhookListEntry> {
	return this.fetchJson(`/api/webhooks/${id}`);
}

async createWebhook(options: CreateWebhookOptions): Promise<WebhookCreateResponse> {
	return this.fetchJson("/api/webhooks", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
}

async updateWebhook(id: string, options: UpdateWebhookOptions): Promise<WebhookListEntry> {
	return this.fetchJson(`/api/webhooks/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
}

async deleteWebhook(id: string): Promise<void> {
	await this.fetchVoid(`/api/webhooks/${id}`, { method: "DELETE" });
}

async rotateWebhookSecret(id: string): Promise<WebhookRotateResponse> {
	return this.fetchJson(`/api/webhooks/${id}/rotate`, { method: "POST" });
}
```

**Step 3: Ensure types are re-exported from package index**

Verify that `packages/client/src/index.ts` re-exports the new webhook types. If it doesn't already export from `./types.js`, add:

```typescript
export type { WebhookListEntry, WebhookCreateResponse, WebhookRotateResponse, CreateWebhookOptions, UpdateWebhookOptions } from "./types.js";
```

This ensures Svelte components can `import type { WebhookListEntry } from "@bound/client"`.

**Testing:**

Verify the methods are correctly typed and callable. Test with a mock server or by verifying the fetch calls are constructed correctly.

Test file: `packages/client/src/__tests__/client-webhooks.test.ts`

**Verification:**

Run: `bun run typecheck`
Expected: Clean

**Commit:** `feat(client): add webhook CRUD methods to BoundClient`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create SecretModal component

**Verifies:** webhook-ingestion.AC6.2, AC6.4, AC6.7

**Files:**
- Create: `packages/web/src/client/components/SecretModal.svelte`

**Implementation:**

Create a modal component following the existing `FilePreviewModal.svelte` pattern:

```svelte
<script lang="ts">
import { onDestroy, onMount } from "svelte";

interface Props {
	secret: string;
	webhookName: string;
	onClose: () => void;
}

const { secret, webhookName, onClose }: Props = $props();

let modalRef: HTMLDivElement | undefined;
let copied = $state(false);

onMount(() => {
	modalRef?.focus();
});

async function copyToClipboard(): Promise<void> {
	await navigator.clipboard.writeText(secret);
	copied = true;
	setTimeout(() => { copied = false; }, 2000);
}

function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") {
		e.preventDefault();
		onClose();
	}
}
</script>

<div class="modal-backdrop">
	<button class="backdrop-close" onclick={onClose} aria-label="Close" tabindex={-1} />
	<div class="modal-panel" role="dialog" aria-modal="true" aria-label="Webhook secret" bind:this={modalRef} onkeydown={handleKeydown} tabindex={-1}>
		<header class="modal-header">
			<h2 class="modal-title">Secret for '{webhookName}'</h2>
			<button class="close-btn" onclick={onClose}>×</button>
		</header>
		<div class="modal-body">
			<p class="warning">Save this secret now — it will not be shown again.</p>
			<div class="secret-display">
				<code class="secret-value">{secret}</code>
				<button class="copy-btn" onclick={copyToClipboard}>
					{copied ? "Copied!" : "Copy"}
				</button>
			</div>
		</div>
	</div>
</div>
```

Key requirements:
- Modal shows secret text in a monospace code block (AC6.2, AC6.4)
- Copy button uses `navigator.clipboard.writeText` (AC6.2)
- After closing, the secret is gone — component is destroyed, not hidden (AC6.7)
- Focus trap and Escape key to close (follows FilePreviewModal pattern)

**Verification:**

Run: `bun run typecheck`
Expected: Clean

**Commit:** `feat(web): add SecretModal component for one-time secret display`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Create WebhookView.svelte

**Verifies:** webhook-ingestion.AC6.1, AC6.2, AC6.3, AC6.4, AC6.5

**Files:**
- Create: `packages/web/src/client/views/WebhookView.svelte`

**Implementation:**

Create a view following the AdvisoryView pattern with three states: list, create form, and detail/edit panel.

Structure:
```svelte
<script lang="ts">
import { onDestroy, onMount } from "svelte";
import DataTable from "../components/DataTable.svelte";
import SecretModal from "../components/SecretModal.svelte";
import { client } from "../lib/client.js";
import type { WebhookListEntry } from "@bound/client";

let webhooks: WebhookListEntry[] = $state([]);
let loading = $state(true);
let view = $state<"list" | "create" | "detail">("list");
let selectedWebhook = $state<WebhookListEntry | null>(null);
let secretModal = $state<{ secret: string; name: string } | null>(null);

// Create form state
let createName = $state("");
let createFormat = $state("github");
let createDescription = $state("");
let createPrompt = $state("");
let createError = $state<string | null>(null);

// Edit form state
let editDescription = $state("");
let editFormat = $state("");
let editPrompt = $state("");

const columns = [
	{ key: "name", label: "Name", width: "2fr", mono: true },
	{ key: "signature_format", label: "Format", width: "1fr" },
	{ key: "description", label: "Description", width: "3fr" },
	{ key: "created_at", label: "Created", width: "2fr" },
];

onMount(() => { loadWebhooks(); });

async function loadWebhooks(): Promise<void> { ... }
async function handleCreate(): Promise<void> { ... }
async function handleDelete(id: string): Promise<void> { ... }
async function handleUpdate(id: string): Promise<void> { ... }
async function handleRotateSecret(id: string): Promise<void> { ... }
</script>
```

Key behaviors:
- **List view (AC6.1):** DataTable with columns: name, format, description, created date. Row click opens detail view.
- **Create (AC6.2):** Form with name, format (select), description, prompt fields. On submit, calls `client.createWebhook()`. On success, shows SecretModal with the returned secret.
- **Detail/Edit (AC6.3):** Shows selected webhook fields. Editable: description, format (select), prompt (textarea). Save button calls `client.updateWebhook()`.
- **Rotate (AC6.4):** Button in detail view calls `client.rotateWebhookSecret()`. On success, shows SecretModal with new secret.
- **Delete (AC6.5):** Button in detail view with `confirm()` dialog. Calls `client.deleteWebhook()`. Returns to list.
- **Secret modal (AC6.7):** Shown via `secretModal` state. Dismissed by setting to `null`. Secret is NOT stored anywhere else.

**Testing:**

This is a UI component — verified via manual testing and Playwright e2e (if available). Automated unit testing of Svelte components is not the project's pattern.

Test approach: Verify via `bun run typecheck` (ensures type safety) and visual inspection.

**Verification:**

Run: `bun run typecheck`
Expected: Clean

**Commit:** `feat(web): add WebhookView with full CRUD and secret display`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Register WebhookView in navigation and router

**Verifies:** webhook-ingestion.AC6.6

**Files:**
- Modify: `packages/web/src/client/components/TopBar.svelte` (add to NAV array)
- Modify: `packages/web/src/client/App.svelte` (add route + import)

**Implementation:**

In `TopBar.svelte`, add to the NAV array:
```typescript
{ hash: "#/webhooks", route: "06", label: "Webhooks" },
```

In `App.svelte`, add import and route:
```svelte
<script>
import WebhookView from "./views/WebhookView.svelte";
</script>

<!-- In the route conditional block: -->
{:else if route === "/webhooks"}
	<WebhookView />
```

**Verification:**

Run: `bun run typecheck`
Expected: Clean

**Commit:** `feat(web): add Webhooks to navigation and router`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Update isUserFacingInterface to exclude "webhook"

**Verifies:** Supports AC6 (webhook threads are system-driven, not interactive)

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (line 182-186, `isUserFacingInterface`)

**Implementation:**

Add `"webhook"` to the non-user-facing filter:

```typescript
export function isUserFacingInterface(threadInterface: string | null | undefined): boolean {
	if (!threadInterface) return false;
	if (threadInterface === "scheduler" || threadInterface === "mcp" || threadInterface === "webhook") return false;
	return true;
}
```

This ensures platform tags don't appear in webhook thread context, matching the treatment of scheduler and mcp interfaces.

**Verification:**

Run: `bun run typecheck`
Expected: Clean

**Commit:** `feat(cli): classify webhook as non-user-facing interface`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Run full test suite and build verification

**Step 1: Run tests**

Run: `bun test --recursive`
Expected: All tests pass

**Step 2: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: Clean

**Step 3: Build verification**

Run: `bun run build`
Expected: Build succeeds (Svelte components compile, client bundle includes WebhookView)

**Commit:** Only if fixes needed: `fix(web): build/lint fixes for webhook UI`
<!-- END_TASK_6 -->
