# Webhook Ingestion Design

## Summary

Bound is adding webhook ingestion to allow external services like GitHub, Stripe, and Slack to trigger agent tasks via HMAC-SHA256-signed HTTP POST requests. When a webhook delivery arrives at the sync server (port 3000) at `/webhook/:name`, the server validates the signature against a stored secret, wraps the raw payload in a structured JSON envelope (method, path, headers, content type, body), and injects it into the existing relay intake pipeline. The relay system routes the envelope to a spoke node with model backends, creates a user message in the webhook's dedicated thread, and invokes the agent loop with a custom prompt injected via a new `tasks.system_prompt_addition` column. This design reuses the established relay intake pattern (identical to Discord event delivery), generalizes the `systemPromptAddition` mechanism to all task types (not just ephemeral WebSocket connections), and provides full CRUD management through `boundctl webhook` commands and a new web UI view with one-time secret display.

The implementation spans six phases: schema changes (new synced `webhooks` table, new `tasks.system_prompt_addition` column), HMAC validation module with support for four signature formats (GitHub, Stripe, Slack, raw), HTTP route handler on the sync server, relay intake wiring with agent loop invocation, CLI commands for webhook lifecycle management, web API routes for CRUD operations, and a Svelte UI with secret modals and navigation integration. The architecture avoids direct dispatch in favor of the relay pipeline, ensuring multi-host routing, deduplication, and hub-only mode work without new code paths.

## Definition of Done

External services (GitHub, Stripe, Slack, etc.) can send HMAC-SHA256-signed webhook deliveries to bound's sync server (port 3000) at `/webhook/:name`, where the signature is validated, the raw payload is delivered as agent input via the relay intake system, and a per-webhook custom prompt (via existing `systemPromptAddition`) tells the agent how to process it. Webhooks are managed through `boundctl webhook {create|list|delete}` and the web UI, with auto-generated secrets shown once at creation time.

Specifically:
1. **New synced `webhooks` table** — stores endpoint name, HMAC secret, associated task+thread, custom prompt string
2. **HTTP handler on port 3000** — `/webhook/:name` validates HMAC-SHA256 signatures, delivers raw payload as agent input via relay intake
3. **`boundctl webhook {create|list|delete}`** — CLI management (auto-generated secret shown once on create)
4. **Web UI webhook management** — CRUD + one-time secret display at creation
5. **Webhook prompt → existing `systemPromptAddition`** — sourced from webhooks table, fed through existing AgentLoopConfig path; no new injection mechanism

## Acceptance Criteria

### webhook-ingestion.AC1: Webhook HMAC-SHA256 validation
- **webhook-ingestion.AC1.1 Success:** Valid GitHub-format signature (`X-Hub-Signature-256: sha256=<hex>`) returns 202 Accepted
- **webhook-ingestion.AC1.2 Success:** Valid Stripe-format signature (`Stripe-Signature: t=<ts>,v1=<hex>`) returns 202 Accepted
- **webhook-ingestion.AC1.3 Success:** Valid Slack-format signature (`X-Slack-Signature: v0=<hex>`) with valid `X-Slack-Request-Timestamp` returns 202 Accepted
- **webhook-ingestion.AC1.4 Success:** Valid raw-format signature (`X-Webhook-Signature: <hex>`) returns 202 Accepted
- **webhook-ingestion.AC1.5 Failure:** Invalid HMAC signature returns 401 with no detail in response body
- **webhook-ingestion.AC1.6 Failure:** Missing signature header returns 401
- **webhook-ingestion.AC1.7 Failure:** Stripe/Slack timestamp older than 5 minutes returns 401 (replay protection)
- **webhook-ingestion.AC1.8 Edge:** Signature comparison uses constant-time (`timingSafeEqual`) to prevent timing attacks

### webhook-ingestion.AC2: HTTP handler on port 3000
- **webhook-ingestion.AC2.1 Success:** POST to `/webhook/:name` with valid signature writes a relay_inbox entry and returns 202
- **webhook-ingestion.AC2.2 Failure:** POST to `/webhook/:name` where name doesn't exist returns 404
- **webhook-ingestion.AC2.3 Failure:** POST with empty or unreadable body returns 400
- **webhook-ingestion.AC2.4 Failure:** Non-POST methods to `/webhook/:name` return 404
- **webhook-ingestion.AC2.5 Edge:** Raw body bytes are preserved exactly (not re-serialized) before HMAC validation
- **webhook-ingestion.AC2.6 Edge:** Existing `/sync/ws` WebSocket endpoint continues to function alongside new HTTP route

### webhook-ingestion.AC3: Relay delivery + agent invocation
- **webhook-ingestion.AC3.1 Success:** Relay intake entry routes to a spoke with models and creates a user message in the webhook's thread
- **webhook-ingestion.AC3.2 Success:** Message content is a structured JSON envelope containing method, path, filtered headers, content_type, and body
- **webhook-ingestion.AC3.3 Success:** Agent loop runs with `systemPromptAddition` populated from `tasks.system_prompt_addition`
- **webhook-ingestion.AC3.4 Success:** Duplicate deliveries (same dedup key) are silently discarded
- **webhook-ingestion.AC3.5 Edge:** Hub-only mode (no local models) routes to spoke via relay rather than failing
- **webhook-ingestion.AC3.6 Edge:** Scheduler-triggered tasks also receive `system_prompt_addition` when present (not just relay-delegated)

### webhook-ingestion.AC4: boundctl webhook commands
- **webhook-ingestion.AC4.1 Success:** `create` generates 256-bit secret, creates webhook+task+thread rows, prints secret and URL once
- **webhook-ingestion.AC4.2 Success:** `list` shows name, format, description, created date (no secret)
- **webhook-ingestion.AC4.3 Success:** `delete` soft-deletes webhook and cancels associated task
- **webhook-ingestion.AC4.4 Success:** `update --prompt` modifies `tasks.system_prompt_addition` on the linked task
- **webhook-ingestion.AC4.5 Success:** `rotate-secret` generates new secret, updates row, prints new secret once
- **webhook-ingestion.AC4.6 Failure:** `create` with invalid name (uppercase, special chars, >64 chars) returns validation error
- **webhook-ingestion.AC4.7 Failure:** `create` with duplicate name (non-deleted webhook exists) returns conflict error

### webhook-ingestion.AC5: Web API routes (port 3001)
- **webhook-ingestion.AC5.1 Success:** POST `/api/webhooks` creates webhook and returns response including secret
- **webhook-ingestion.AC5.2 Success:** GET `/api/webhooks` returns list without secret field
- **webhook-ingestion.AC5.3 Success:** PATCH `/api/webhooks/:id` updates only editable fields (description, prompt, format)
- **webhook-ingestion.AC5.4 Success:** DELETE `/api/webhooks/:id` soft-deletes webhook and cancels task
- **webhook-ingestion.AC5.5 Success:** POST `/api/webhooks/:id/rotate` returns new secret only
- **webhook-ingestion.AC5.6 Failure:** GET `/api/webhooks/:id` does not include secret in response
- **webhook-ingestion.AC5.7 Failure:** PATCH with non-editable fields (name, thread_id, secret) has no effect / returns error

### webhook-ingestion.AC6: Web UI (full CRUD)
- **webhook-ingestion.AC6.1 Success:** Webhook list view shows all webhooks with name, format, description, date
- **webhook-ingestion.AC6.2 Success:** Create form produces webhook and displays secret in one-time modal with copy button
- **webhook-ingestion.AC6.3 Success:** Detail view allows editing prompt, description, and format
- **webhook-ingestion.AC6.4 Success:** Rotate secret button shows new secret in one-time modal
- **webhook-ingestion.AC6.5 Success:** Delete button with confirmation soft-deletes webhook
- **webhook-ingestion.AC6.6 Success:** Webhook view accessible from main navigation
- **webhook-ingestion.AC6.7 Edge:** After dismissing secret modal, secret is no longer retrievable from the UI

## Glossary

- **HMAC-SHA256**: Hash-based Message Authentication Code using SHA-256. A shared secret key computes a hash of a message, proving both authenticity (message came from someone with the secret) and integrity (message wasn't tampered with).
- **Relay intake**: The existing ingestion pipeline in bound that accepts external events (currently Discord platform events), deduplicates them, routes to a target host via tiered affinity rules (platform → thread → model), and writes a relay outbox entry for execution.
- **Spoke / Hub**: Bound's multi-host architecture. A spoke has local model backends and runs agent loops. A hub coordinates routing but may have no local models (hub-only mode).
- **Synced table**: A database table whose writes generate change-log entries that replicate across hosts via the sync protocol. Must use `insertRow`/`updateRow`/`softDelete` (never raw SQL) and use LWW or append-only conflict resolution.
- **LWW (last-write-wins)**: Conflict resolution where the row with the latest `modified_at` timestamp wins during cross-host replay.
- **Soft delete**: Rows marked `deleted = 1` rather than physically removed, allowing sync protocol to propagate deletions.
- **Agent loop**: Core state machine that processes a queued message: hydrate filesystem → assemble context → call LLM → execute tools → persist results.
- **`systemPromptAddition`**: Optional text injected into the agent's system prompt for a loop invocation. Previously ephemeral (WebSocket only). This design persists it on task rows.
- **Timing-safe comparison**: Cryptographic comparison that takes constant time regardless of where strings differ, preventing timing side-channel attacks on HMAC secrets.
- **Event task**: A task with `type: "event"` and a `trigger_spec` like `"webhook:<name>"`, fired when the matching event appears on the event bus. Contrasts with cron (time-based) and deferred (one-shot) tasks.
- **Outbox pattern**: Database pattern where writes to application tables are paired with change-log writes in the same transaction, ensuring changes propagate to other hosts.
- **Deterministic UUID**: UUID generated from a namespace and name via hash function (UUID v5), producing the same ID every time for the same inputs. Used for entities with natural keys to avoid sync conflicts.
- **Hono**: Lightweight web framework for HTTP APIs in TypeScript, used by bound's web server (port 3001).
- **Svelte 5**: JavaScript UI framework used for bound's web interface. Version 5 introduced runes (reactive primitives).

## Architecture

Webhook ingestion follows the existing relay intake pattern (identical to Discord platform event delivery). The sync server (port 3000) gains an HTTP route alongside its existing WebSocket endpoint. Incoming deliveries are validated, wrapped in a structured envelope, and injected into the relay pipeline for routing to a spoke with models.

**Data flow:**

```
External Service (GitHub/Stripe/Slack)
    → POST /webhook/:name (port 3000, sync server)
    → Validate HMAC-SHA256 signature
    → Build structured envelope (method, path, headers, content_type, body)
    → Write relay_inbox entry (kind: "intake", platform: "webhook")
    → 202 Accepted
    → RelayProcessor.handleIntake() deduplicates, routes to target host
    → Target host executeProcess() creates message + enqueues thread
    → Scheduler fires event task → AgentLoop with systemPromptAddition
```

**Key architectural decisions:**

- **Relay intake (not direct dispatch):** Matches existing platform event pattern. Multi-host routing, deduplication, and hub-only mode work immediately.
- **`system_prompt_addition` on `tasks` table:** Fixes a pre-existing gap where scheduler and relay-delegated loops had no mechanism for persistent prompt injection. Generalizes to all task types (cron, event, deferred), not just webhooks.
- **HMAC-SHA256 only:** Covers GitHub, Stripe, Slack, and GitLab modern. Ed25519 (Discord) and bearer tokens deferred.
- **Structured envelope as message content:** Agent receives full request context (method, filtered headers, content type, body) in a JSON envelope. No server-side content parsing.
- **Auto-generated secrets:** 256-bit entropy (32 random bytes, hex-encoded). Stored retrievably (required for HMAC recomputation). Displayed once at creation and on rotation.

**Components:**

| Component | Package | Responsibility |
|-----------|---------|---------------|
| `webhooks` table | `@bound/core` | Schema, sync registration |
| `tasks.system_prompt_addition` column | `@bound/core` | Migration, schema update |
| Webhook HTTP handler | `@bound/web` (sync server) | HMAC validation, envelope construction, relay write |
| HMAC validation module | `@bound/web` | Signature extraction, format-specific payload construction, timing-safe comparison |
| Webhook API routes | `@bound/web` (web server) | REST CRUD on port 3001 |
| `boundctl webhook` commands | `@bound/cli` | CLI management |
| Scheduler `systemPromptAddition` wiring | `@bound/agent` | Read `system_prompt_addition` from task row, inject into AgentLoopConfig |
| Relay processor `systemPromptAddition` wiring | `@bound/agent` | Read `system_prompt_addition` from owning task, inject into delegated loop config |
| `BoundClient` SDK methods | `@bound/client` | `createWebhook`, `listWebhooks`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret` |
| `WebhookView.svelte` | `@bound/web` (client) | Full CRUD UI with one-time secret display |

## Existing Patterns

**Relay intake (Discord platform events):** The webhook delivery pipeline follows the exact flow established for Discord event delivery. `handleIntake()` in `packages/agent/src/relay-processor.ts` (line 514) validates the intake payload, deduplicates via idempotency cache, routes to a target host via `selectIntakeHost()` (tiered: platform affinity → thread affinity → model match), and writes a `"process"` outbox entry. Webhooks use platform `"webhook"` with no special host affinity (unlike Discord which has Tier 0 platform affinity).

**Synced table pattern (connector_handles):** The `webhooks` table follows the same synced-LWW pattern as `connector_handles` in `packages/platforms/src/connector-handle.ts` — deterministic UUID, soft deletes, unique partial index on name, all writes via outbox helpers.

**Event task pattern (scheduler):** Webhook tasks use `type: "event"` with `trigger_spec: "webhook:<name>"`, matching the existing event trigger mechanism in `packages/agent/src/scheduler.ts`. The scheduler's `onEvent()` (line 1253) receives trigger specs from the event bus.

**`systemPromptAddition` flow (boundless/WS):** The infrastructure for injecting per-loop prompt additions exists end-to-end from `AgentLoopConfig.systemPromptAddition` through `ContextParams` to volatile context injection in `packages/agent/src/context-assembly.ts` (lines 387-391). Currently sourced only from ephemeral WS connections (via `wsRegistry.getSystemPromptAdditionForThread()`). This design adds a persistent source via `tasks.system_prompt_addition`.

**Divergence from existing patterns:**

The sync server (port 3000) currently serves only WebSocket connections and returns 404 for all HTTP requests. Adding an HTTP route is a structural change to `createSyncServer()` in `packages/web/src/server/start.ts`. The handler is a standalone function (not Hono) since the sync server uses raw `Bun.serve`.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Schema + Sync Registration

**Goal:** `webhooks` table exists, syncs across hosts, `tasks.system_prompt_addition` column available.

**Components:**
- Schema in `packages/core/src/schema.ts` — CREATE TABLE for `webhooks`, ALTER TABLE for `tasks.system_prompt_addition`
- `SyncedTableName` and `TABLE_REDUCER_MAP` in `packages/shared/src/types.ts` — add `"webhooks"` as LWW
- `SYNCED_TABLE_NAMES` in `packages/core/src/schema-introspection.ts` — expose to agent query tool
- `SNAPSHOT_TABLE_ORDER` in `packages/sync/src/ws-transport.ts` — include in snapshot seeding

**Dependencies:** None (first phase)

**Done when:** Schema creates successfully, table appears in sync infrastructure, `system_prompt_addition` column accessible on tasks, existing tests pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: HMAC Validation + HTTP Handler

**Goal:** Port 3000 accepts POST `/webhook/:name`, validates HMAC-SHA256 signatures, returns appropriate HTTP status codes.

**Components:**
- HMAC validation module in `packages/web/src/server/` — signature extraction per format (github, stripe, slack, raw), timing-safe comparison, replay protection for timestamp-aware formats
- Webhook HTTP handler in `packages/web/src/server/start.ts` — route matching, DB lookup, body preservation, validation dispatch, response codes
- `SignatureFormat` type — `"github" | "stripe" | "slack" | "raw"` enum

**Dependencies:** Phase 1 (webhooks table must exist for DB lookup)

**Done when:** Tests verify: valid GitHub-format signature returns 202, invalid signature returns 401, unknown webhook name returns 404, missing body returns 400, replay attack (stale timestamp for Stripe/Slack formats) returns 401. Timing-safe comparison used for all HMAC checks. Covers `webhook-ingestion.AC1.*` and `webhook-ingestion.AC2.*`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Relay Intake + Agent Delivery

**Goal:** Validated webhook payloads flow through the relay pipeline and arrive as messages in the webhook's thread.

**Components:**
- Relay inbox write in webhook HTTP handler — builds intake payload with structured envelope, dedup key, thread_id from webhook row
- Event bus trigger emission — fires `webhook:<name>` event after relay write
- Scheduler `systemPromptAddition` wiring in `packages/agent/src/scheduler.ts` — read `system_prompt_addition` from task row when building AgentLoopConfig (line ~1010-1025)
- Relay processor `systemPromptAddition` wiring in `packages/agent/src/relay-processor.ts` — expand `runDelegatedLoop` owning-task SELECT to include `system_prompt_addition`, inject into loopConfig (line ~1540-1555)

**Dependencies:** Phase 2 (handler must validate before writing relay entry)

**Done when:** End-to-end test: webhook POST → relay inbox entry created → message appears in thread → agent loop invoked with correct `systemPromptAddition`. Covers `webhook-ingestion.AC3.*`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: boundctl Webhook Commands

**Goal:** Full CLI management of webhooks: create, list, delete, update, rotate-secret.

**Components:**
- `boundctl webhook create` — validate name, generate secret, create thread + task + webhook rows, print secret once
- `boundctl webhook list` — tabular display (name, format, description, created date; no secret)
- `boundctl webhook delete` — soft-delete webhook, cancel associated task
- `boundctl webhook update` — edit description, prompt (→ task.system_prompt_addition), format
- `boundctl webhook rotate-secret` — generate new secret, update row, print new secret once
- All commands in `packages/cli/src/boundctl.ts`

**Dependencies:** Phase 1 (schema), Phase 3 (task creation with system_prompt_addition)

**Done when:** All five commands work end-to-end against a real database. Secret displayed only on create and rotate. Delete cancels the task. Update modifies correct fields on both webhook and task rows. Covers `webhook-ingestion.AC4.*`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Web API Routes

**Goal:** REST endpoints on port 3001 for webhook CRUD, supporting the web UI.

**Components:**
- `packages/web/src/server/routes/webhooks.ts` — route factory following existing pattern (like `createAdvisoriesRoutes`)
- Route registration in `packages/web/src/server/routes/index.ts`
- Endpoints: GET/POST `/api/webhooks`, GET/PATCH/DELETE `/api/webhooks/:id`, POST `/api/webhooks/:id/rotate`
- Secret filtering — only include secret in POST create and POST rotate responses

**Dependencies:** Phase 1 (schema)

**Done when:** All endpoints return correct responses. Secret only appears in create and rotate responses. Delete soft-deletes webhook and cancels task. Update modifies only editable fields. Covers `webhook-ingestion.AC5.*`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: BoundClient SDK + Web UI

**Goal:** Full CRUD web interface for webhook management with one-time secret display.

**Components:**
- `BoundClient` methods in `packages/client/src/client.ts` — `createWebhook`, `listWebhooks`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`
- `WebhookView.svelte` in `packages/web/src/client/views/` — list view with DataTable, create form, detail/edit panel
- Secret display modal — shown once on create and rotate, with copy button
- Navigation entry — tab/route in app TopBar
- `isUserFacingInterface` update in `packages/cli/src/commands/start/server.ts` — add `"webhook"` to non-user-facing filter

**Dependencies:** Phase 5 (API routes must exist)

**Done when:** Web UI shows webhook list, creates webhooks with secret displayed once, edits prompt/description/format, rotates secrets, deletes webhooks. Navigation accessible from main app. Covers `webhook-ingestion.AC6.*`.
<!-- END_PHASE_6 -->

## Additional Considerations

**Header filtering for envelope:** The structured envelope includes a filtered subset of request headers — event-type headers (`x-github-event`, `x-github-delivery`, `x-stripe-event`, etc.), content-type, and delivery IDs. Excluded: signature headers (no reason to expose HMAC to agent), standard HTTP noise (`host`, `connection`, `content-length`, `accept-encoding`).

**Replay protection scope:** Only applies to signature formats that include timestamps in their HMAC construction (Stripe, Slack — 5-minute window). GitHub and raw formats do not include timestamps and rely solely on the HMAC secret for authentication. External services handle their own retry logic.

**Secret storage security:** The HMAC secret is stored in plaintext in the database because it must be retrieved on every incoming request to recompute the HMAC. Since bound runs on user-owned infrastructure with existing database access controls, this is acceptable. The "show once" UX pattern reduces casual exposure, not access.

**Mutability rules:** Only `prompt` (stored on `tasks.system_prompt_addition`), `description`, and `signature_format` are editable. `name`, `thread_id`, `task_id` are immutable (external services have URLs hardcoded; thread/task are structural). Secret has a dedicated rotation operation rather than freeform editing.

**`isUserFacingInterface` classification:** Webhook threads are system-driven (not interactive). Adding `"webhook"` to the non-user-facing filter means platform tags won't appear in webhook thread context, matching the treatment of `"scheduler"` and `"mcp"` interfaces.
