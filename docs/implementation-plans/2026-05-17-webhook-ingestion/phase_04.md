# Webhook Ingestion Implementation Plan — Phase 4

**Goal:** Full CLI management of webhooks: create, list, delete, update, rotate-secret via `boundctl webhook` commands.

**Architecture:** New `packages/cli/src/commands/webhook.ts` module following the existing `skill.ts` pattern (exported functions called from the `boundctl-main.ts` if-else dispatcher). Each command uses `insertRow`/`updateRow`/`softDelete` for synced table writes. Webhook creation also creates a thread (for message delivery) and an event task (for scheduler triggering).

**Tech Stack:** TypeScript, bun:sqlite, node:crypto (randomBytes for secret generation)

**Scope:** 6 phases from original design (this is phase 4 of 6)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### webhook-ingestion.AC4: boundctl webhook commands
- **webhook-ingestion.AC4.1 Success:** `create` generates 256-bit secret, creates webhook+task+thread rows, prints secret and URL once
- **webhook-ingestion.AC4.2 Success:** `list` shows name, format, description, created date (no secret)
- **webhook-ingestion.AC4.3 Success:** `delete` soft-deletes webhook and cancels associated task
- **webhook-ingestion.AC4.4 Success:** `update --prompt` modifies `tasks.system_prompt_addition` on the linked task
- **webhook-ingestion.AC4.5 Success:** `rotate-secret` generates new secret, updates row, prints new secret once
- **webhook-ingestion.AC4.6 Failure:** `create` with invalid name (uppercase, special chars, >64 chars) returns validation error
- **webhook-ingestion.AC4.7 Failure:** `create` with duplicate name (non-deleted webhook exists) returns conflict error

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Create webhook command module with `create` command

**Verifies:** webhook-ingestion.AC4.1, AC4.6, AC4.7

**Files:**
- Create: `packages/cli/src/commands/webhook.ts`

**Implementation:**

Create a module exporting `webhookCreate(db, siteId, args)` following the `skill.ts` pattern:

```typescript
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { SignatureFormat } from "@bound/shared";
```

The `webhookCreate` function:

1. Parse args: `--name <name>`, `--format <format>` (default "github"), `--description <text>`, `--prompt <text>`
2. Validate name: regex `/^[a-z0-9][a-z0-9_-]{0,63}$/` — reject with error if uppercase, special chars, or >64 chars (AC4.6)
3. Check for existing non-deleted webhook: `SELECT id FROM webhooks WHERE name = ? AND deleted = 0` — reject with conflict error if found (AC4.7)
4. Generate 256-bit secret: `randomBytes(32).toString("hex")` (64 hex chars)
5. Create thread for webhook message delivery:
   ```typescript
   const threadId = randomUUID();
   insertRow(db, "threads", {
     id: threadId,
     user_id: "system",
     interface: "webhook",
     host_origin: null,
     color: 0,
     title: `Webhook: ${name}`,
     summary: null,
     summary_through: null,
     summary_model_id: null,
     extracted_through: null,
     model_hint: null,
     created_at: now,
     last_message_at: now,
     modified_at: now,
     deleted: 0,
   }, siteId);
   ```
6. Create event task:
   ```typescript
   const taskId = randomUUID();
   insertRow(db, "tasks", {
     id: taskId,
     type: "event",
     status: "pending",
     trigger_spec: `webhook:${name}`,
     payload: null,
     created_at: now,
     created_by: siteId,
     thread_id: threadId,
     origin_thread_id: null,
     claimed_by: null,
     claimed_at: null,
     lease_id: null,
     next_run_at: null,
     last_run_at: null,
     run_count: 0,
     max_runs: null,
     requires: null,
     model_hint: null,
     no_history: 0,
     inject_mode: "results",
     depends_on: null,
     require_success: 0,
     alert_threshold: 3,
     consecutive_failures: 0,
     event_depth: 0,
     no_quiescence: 0,
     heartbeat_at: null,
     result: null,
     error: null,
     system_prompt_addition: prompt || null,
     modified_at: now,
     deleted: 0,
   }, siteId);
   ```
7. Create webhook row:
   ```typescript
   const webhookId = deterministicUUID(BOUND_NAMESPACE, `webhook:${name}`);
   insertRow(db, "webhooks", {
     id: webhookId,
     name,
     secret,
     signature_format: format,
     description: description || null,
     task_id: taskId,
     thread_id: threadId,
     created_at: now,
     deleted: 0,
     modified_at: now,
   }, siteId);
   ```
8. Print output:
   ```
   Webhook created: ${name}
   URL: /webhook/${name}
   Secret: ${secret}
   Format: ${format}

   ⚠ Save the secret now — it will not be shown again.
   ```

**Testing:**

Tests must verify:
- webhook-ingestion.AC4.1: Create with valid name produces webhook, task, and thread rows; secret is 64 hex chars; prints secret
- webhook-ingestion.AC4.6: Create with "MyWebhook" (uppercase) throws validation error; create with "a".repeat(65) throws; create with "my webhook!" (special chars) throws
- webhook-ingestion.AC4.7: Create same name twice (without deleting) throws conflict error

Test file: `packages/cli/src/commands/__tests__/webhook.test.ts`

Setup: In-memory SQLite with `applySchema(db)`, call `webhookCreate` directly.

**Verification:**

Run: `bun test packages/cli/src/commands/__tests__/webhook.test.ts`
Expected: All tests pass

**Commit:** `feat(cli): add boundctl webhook create command`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add `list`, `delete`, `update`, `rotate-secret` commands

**Verifies:** webhook-ingestion.AC4.2, AC4.3, AC4.4, AC4.5

**Files:**
- Modify: `packages/cli/src/commands/webhook.ts`

**Implementation:**

Add four exported functions to the webhook module:

**`webhookList(db)`:**
- Query: `SELECT name, signature_format, description, created_at FROM webhooks WHERE deleted = 0 ORDER BY created_at DESC`
- Print tabular output (padded columns):
  ```
  NAME              FORMAT    DESCRIPTION          CREATED
  github-events     github    Push notifications   2026-05-17T10:30:00
  stripe-payments   stripe    Payment events       2026-05-16T08:15:00
  ```
- No secret in output (AC4.2)

**`webhookDelete(db, siteId, name)`:**
- Look up webhook: `SELECT id, task_id FROM webhooks WHERE name = ? AND deleted = 0`
- Error if not found
- Soft-delete webhook: `softDelete(db, "webhooks", webhookId, siteId)`
- Cancel associated task: `updateRow(db, "tasks", { id: taskId, status: "cancelled", modified_at: now }, siteId)`
- Print: `Webhook '${name}' deleted.`

**`webhookUpdate(db, siteId, args)`:**
- Parse: `--name <name>` (required, to identify webhook), `--prompt <text>`, `--description <text>`, `--format <format>`
- Look up webhook + task_id
- If `--prompt` provided: `updateRow(db, "tasks", { id: taskId, system_prompt_addition: prompt, modified_at: now }, siteId)` (AC4.4)
- If `--description` provided: `updateRow(db, "webhooks", { id: webhookId, description, modified_at: now }, siteId)`
- If `--format` provided: `updateRow(db, "webhooks", { id: webhookId, signature_format: format, modified_at: now }, siteId)`
- Print: `Webhook '${name}' updated.`

**`webhookRotateSecret(db, siteId, name)`:**
- Look up webhook
- Generate new secret: `randomBytes(32).toString("hex")`
- `updateRow(db, "webhooks", { id: webhookId, secret: newSecret, modified_at: now }, siteId)`
- Print:
  ```
  New secret for '${name}': ${newSecret}
  ⚠ Save the secret now — it will not be shown again.
  ```

**Testing:**

Tests must verify:
- webhook-ingestion.AC4.2: list returns rows without secret field
- webhook-ingestion.AC4.3: delete soft-deletes webhook (deleted=1) and sets task status to "cancelled"
- webhook-ingestion.AC4.4: update with --prompt modifies task.system_prompt_addition
- webhook-ingestion.AC4.5: rotate-secret changes webhook.secret and prints new value

Test file: `packages/cli/src/commands/__tests__/webhook.test.ts` (extend)

**Verification:**

Run: `bun test packages/cli/src/commands/__tests__/webhook.test.ts`
Expected: All tests pass

**Commit:** `feat(cli): add boundctl webhook list/delete/update/rotate-secret commands`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Register webhook commands in boundctl-main.ts

**Files:**
- Modify: `packages/cli/src/boundctl-main.ts` (add webhook command block after skill commands, around line 344)

**Implementation:**

Add after the `skill` command block (line 344), before the `db` command:

```typescript
if (command === "webhook") {
	const { webhookCreate, webhookList, webhookDelete, webhookUpdate, webhookRotateSecret } = await import("./commands/webhook.js");
	const subcommand = args[1];
	const dataDir = getArgValue(args, "--data-dir") || "data";
	const db = openBoundDB(dataDir);
	const siteId = getSiteId(db);

	if (subcommand === "create") {
		webhookCreate(db, siteId, args.slice(2));
	} else if (subcommand === "list") {
		webhookList(db);
	} else if (subcommand === "delete") {
		const name = args[2];
		if (!name) { console.error("Usage: boundctl webhook delete <name>"); process.exit(1); }
		webhookDelete(db, siteId, name);
	} else if (subcommand === "update") {
		webhookUpdate(db, siteId, args.slice(2));
	} else if (subcommand === "rotate-secret") {
		const name = args[2];
		if (!name) { console.error("Usage: boundctl webhook rotate-secret <name>"); process.exit(1); }
		webhookRotateSecret(db, siteId, name);
	} else {
		console.error("Usage: boundctl webhook {create|list|delete|update|rotate-secret}");
		process.exit(1);
	}

	db.close();
	process.exit(0);
}
```

Also add `webhook` to the help output at the top of the file.

**Verification:**

Run: `bun run typecheck`
Expected: Clean

Run: `bun test --recursive`
Expected: All tests pass

**Commit:** `feat(cli): register webhook subcommand in boundctl`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Run full test suite

**Step 1: Run tests**

Run: `bun test --recursive`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean

**Commit:** Only if fixes needed: `fix(cli): type/test fixes for webhook commands`
<!-- END_TASK_4 -->
