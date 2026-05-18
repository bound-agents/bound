# Webhook Ingestion Implementation Plan — Phase 5

**Goal:** REST endpoints on port 3001 for webhook CRUD, supporting the web UI.

**Architecture:** New Hono route factory (`createWebhooksRoutes`) following the established `createAdvisoriesRoutes` pattern. Registered in the routes index. Secret filtering ensures secrets only appear in POST create and POST rotate responses.

**Tech Stack:** Hono, TypeScript, bun:sqlite

**Scope:** 6 phases from original design (this is phase 5 of 6)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### webhook-ingestion.AC5: Web API routes (port 3001)
- **webhook-ingestion.AC5.1 Success:** POST `/api/webhooks` creates webhook and returns response including secret
- **webhook-ingestion.AC5.2 Success:** GET `/api/webhooks` returns list without secret field
- **webhook-ingestion.AC5.3 Success:** PATCH `/api/webhooks/:id` updates only editable fields (description, prompt, format)
- **webhook-ingestion.AC5.4 Success:** DELETE `/api/webhooks/:id` soft-deletes webhook and cancels task
- **webhook-ingestion.AC5.5 Success:** POST `/api/webhooks/:id/rotate` returns new secret only
- **webhook-ingestion.AC5.6 Failure:** GET `/api/webhooks/:id` does not include secret in response
- **webhook-ingestion.AC5.7 Failure:** PATCH with non-editable fields (name, thread_id, secret) has no effect / returns error

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Create webhooks route factory

**Verifies:** webhook-ingestion.AC5.1, AC5.2, AC5.3, AC5.4, AC5.5, AC5.6, AC5.7

**Files:**
- Create: `packages/web/src/server/routes/webhooks.ts`

**Implementation:**

Create a Hono route factory following the `createAdvisoriesRoutes` pattern:

```typescript
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { getSiteId, insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { SignatureFormat, Webhook } from "@bound/shared";

export function createWebhooksRoutes(db: Database): Hono {
	const app = new Hono();

	function resolveSiteId(): string {
		return getSiteId(db);
	}

	// ... routes

	return app;
}
```

**Routes to implement:**

**GET `/` — List webhooks (AC5.2)**
- Query: `SELECT id, name, signature_format, description, task_id, thread_id, created_at, modified_at FROM webhooks WHERE deleted = 0 ORDER BY created_at DESC`
- Return JSON array WITHOUT `secret` field
- Also exclude secret from individual webhook GETs (AC5.6)

**GET `/:id` — Get single webhook (AC5.6)**
- Query by id, return all fields EXCEPT `secret`
- 404 if not found or deleted

**POST `/` — Create webhook (AC5.1)**
- Accept JSON body: `{ name, format?, description?, prompt? }`
- Validate name: regex `/^[a-z0-9][a-z0-9_-]{0,63}$/`
- Check uniqueness (non-deleted)
- Generate secret, create thread + task + webhook (same logic as Phase 4 CLI create)
- Return full webhook object INCLUDING `secret` (only time secret is exposed)
- Status 201

**PATCH `/:id` — Update webhook (AC5.3, AC5.7)**
- Accept JSON body with editable fields only: `{ description?, prompt?, format? }`
- Look up webhook by id
- If `prompt` provided: update `tasks.system_prompt_addition` on linked task
- If `description` or `format` provided: update webhook row
- Ignore any non-editable fields (name, thread_id, secret) — do not error, just drop them (AC5.7)
- Return updated webhook (without secret)
- 404 if not found

**DELETE `/:id` — Soft-delete webhook (AC5.4)**
- `softDelete(db, "webhooks", id, siteId)`
- Cancel associated task: `updateRow(db, "tasks", { id: taskId, status: "cancelled", modified_at: now }, siteId)`
- Status 204

**POST `/:id/rotate` — Rotate secret (AC5.5)**
- Generate new secret: `randomBytes(32).toString("hex")`
- `updateRow(db, "webhooks", { id, secret: newSecret, modified_at: now }, siteId)`
- Return: `{ secret: newSecret }` (only the new secret)

**Testing:**

Tests must verify each AC:
- webhook-ingestion.AC5.1: POST creates webhook, response includes `secret` field
- webhook-ingestion.AC5.2: GET list returns webhooks without `secret` field
- webhook-ingestion.AC5.3: PATCH with `{ description: "new" }` updates description; PATCH with `{ prompt: "new prompt" }` updates task.system_prompt_addition
- webhook-ingestion.AC5.4: DELETE soft-deletes (webhook.deleted=1) and cancels task (task.status="cancelled")
- webhook-ingestion.AC5.5: POST rotate returns new secret, verify webhook.secret in DB changed
- webhook-ingestion.AC5.6: GET single webhook does NOT include `secret` in response body
- webhook-ingestion.AC5.7: PATCH with `{ name: "new-name", thread_id: "xxx" }` does not change those fields in DB

Test file: `packages/web/src/server/__tests__/webhooks-routes.test.ts`

Setup: In-memory DB with `applySchema(db)`, create Hono app with `createWebhooksRoutes(db)`, test via `app.fetch(new Request(...))`.

**Verification:**

Run: `bun test packages/web/src/server/__tests__/webhooks-routes.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add webhook CRUD API routes`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Register webhooks routes in index.ts

**Files:**
- Modify: `packages/web/src/server/routes/index.ts` (add to registerRoutes return object)
- Modify: `packages/web/src/server/index.ts` (add `app.route("/api/webhooks", routes.webhooks)`)

**Implementation:**

In `packages/web/src/server/routes/index.ts`, add to the return object:

```typescript
import { createWebhooksRoutes } from "./webhooks.js";

// In registerRoutes return:
webhooks: createWebhooksRoutes(db),
```

In `packages/web/src/server/index.ts`, add after the existing route registrations:

```typescript
app.route("/api/webhooks", routes.webhooks);
```

**Verification:**

Run: `bun run typecheck`
Expected: Clean

Run: `bun test --recursive`
Expected: All tests pass

**Commit:** `feat(web): register webhook routes in web server`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Run full test suite

**Step 1: Run tests**

Run: `bun test --recursive`
Expected: All tests pass

**Step 2: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: Clean

**Commit:** Only if fixes needed: `fix(web): lint/type fixes for webhook routes`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
