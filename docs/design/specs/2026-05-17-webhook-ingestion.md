# RFC: Webhook Ingestion

**Supplements:** `web-and-discord.md` (generic `/hooks/:platform` ingress and `platform:webhook` event), `2026-03-25-service-channel.md` (relay intake pipeline)
**Date:** 2026-05-17
**Status:** Implemented

---

## 1. Problem Statement

External services like GitHub, Stripe, and Slack can trigger work in Bound via webhook deliveries, but no mechanism exists to accept, authenticate, and route these HTTP POST payloads into the agent system. The existing platform connector framework supports persistent gateway connections (Discord) and plans for future webhook-based platforms, but lacks:

1. **Signature validation infrastructure.** HMAC-SHA256 is the standard authentication mechanism for webhook deliveries. Bound needs a validation module that handles multiple vendor-specific signature formats (GitHub, Stripe, Slack) plus a raw format for custom integrations.

2. **Structured payload delivery.** Webhook payloads arrive as raw HTTP bodies with vendor-specific headers. The agent needs to receive these in a structured JSON envelope (method, path, headers, content type, body) that preserves full request context while filtering sensitive signature headers.

3. **Per-webhook custom prompts.** Different webhook endpoints should invoke different agent behaviors. A GitHub push webhook might analyze commit messages; a Stripe payment webhook might update subscription records. The agent needs per-webhook prompt injection without creating one task type per webhook.

4. **Lifecycle management.** Webhooks require CRUD operations (create, list, delete, update prompt, rotate secret), a web UI for operator visibility, and CLI tooling. Auto-generated secrets must be shown once at creation/rotation to prevent exposure in logs.

5. **Relay-aware routing.** In hub-only deployments (no local models), webhook processing must route through the relay intake pipeline to spokes with model backends, not fail locally.

Without these capabilities, external services cannot trigger Bound agent workflows via HTTP, limiting automation to scheduled tasks and interactive conversations only.

---

## 2. Proposal

Add webhook ingestion to Bound by extending the relay intake pipeline with HMAC-SHA256-validated HTTP endpoints on the sync server (port 3000). When a webhook delivery arrives at `POST /hooks/webhook/:name`, the server validates the signature against a stored secret, wraps the raw payload in a structured JSON envelope (method, path, filtered headers, content type, body), and writes it to the relay intake pipeline. The relay system routes the envelope to a spoke with model backends, creates a user message in the webhook's dedicated thread, and invokes the agent loop with a custom prompt injected via `tasks.system_prompt_addition`.

This design reuses the established relay intake pattern (identical to Discord event delivery), generalizes the `system_prompt_addition` mechanism to all task types (not just ephemeral WebSocket connections), and provides full CRUD management through `boundctl webhook` commands and web UI views with one-time secret display.

### 2.1 Core Components

**Synced `webhooks` table:** Stores webhook name, HMAC secret, associated task and thread IDs, signature format, description, and custom prompt. LWW conflict resolution, deterministic UUID based on name, soft deletes. Follows the same pattern as `connector_handles` table.

**`tasks.system_prompt_addition` column:** New nullable TEXT column on the `tasks` table. Holds per-task custom prompt text that is injected into volatile context at agent loop start. Sourced from `webhooks.prompt` for webhook tasks, or any other task-specific prompt source for future task types. Generalizes the ephemeral `systemPromptAddition` mechanism (currently WebSocket-only) to persistent task configuration.

**HMAC validation module:** Signature extraction, format-specific payload construction, and timing-safe comparison for four formats:
- **GitHub:** Header `X-Hub-Signature-256: sha256=<hex>`, payload is raw body bytes.
- **Stripe:** Header `Stripe-Signature: t=<ts>,v1=<hex>`, payload is `<ts>.<raw_body>`, enforces 5-minute timestamp window.
- **Slack:** Header `X-Slack-Signature: v0=<hex>`, payload is `v0:<version>:<ts>:<raw_body>`, enforces 5-minute timestamp window.
- **Raw:** Header `X-Webhook-Signature: <hex>`, payload is raw body bytes (no timestamp).

All comparisons use `timingSafeEqual` from Node.js crypto to prevent timing attacks.

**HTTP route handler on sync server:** Registered alongside the existing WebSocket handler at `/sync/ws`. Accepts `POST /hooks/webhook/:name`, validates webhook existence, reads raw body bytes, validates HMAC signature, constructs structured envelope, writes relay intake entry, returns 202 Accepted. Non-POST methods and unknown webhook names return 404. Invalid signatures return 401 with no detail. Body read errors return 400.

**Relay intake wiring:** Webhook intake entries use `platform: "webhook"`, no host affinity (unlike Discord which has Tier 0 connector affinity). Hub routes to spokes via standard four-tier routing (thread affinity → model match → tool match → least-loaded). Processing host creates user message from envelope content, reads `system_prompt_addition` from task row, injects into AgentLoopConfig, runs agent loop.

**CLI management:** `boundctl webhook create/list/delete/update/rotate-secret` commands. Create generates 256-bit secret (32 random bytes, hex-encoded), displays secret and URL once. List shows name, format, description, created date (no secret). Delete soft-deletes webhook and cancels task. Update modifies prompt (stored on task row) and description. Rotate generates new secret, displays once.

**Web API routes:** REST endpoints on port 3001: `POST /api/webhooks` (create, returns secret), `GET /api/webhooks` (list without secrets), `PATCH /api/webhooks/:id` (edit prompt/description/format), `DELETE /api/webhooks/:id` (soft-delete), `POST /api/webhooks/:id/rotate` (rotate secret, returns new secret only). Secret field appears ONLY in create and rotate responses.

**Web UI:** Full CRUD interface at `#/webhooks` with list view (DataTable), create form, detail/edit panel, one-time secret display modals (create and rotate), and navigation tab. After dismissing secret modal, secret is never retrievable from UI again.

### 2.2 Scope and Non-Goals

**In scope:**
- HMAC-SHA256 validation (four formats covering GitHub, Stripe, Slack, custom integrations)
- Relay intake pipeline integration (reuses Discord platform event pattern)
- Per-webhook threads and tasks (one thread per webhook, one event task per webhook)
- Custom prompt injection via `tasks.system_prompt_addition`
- CLI and web UI CRUD with one-time secret display
- Auto-generated 256-bit secrets
- Hub-only mode support (routing via relay, not local processing)

**Out of scope (deferred):**
- Ed25519 signature validation (Discord's signature scheme; Discord uses gateway, not webhooks)
- Bearer token authentication (simpler but less secure than HMAC; add if user demand surfaces)
- Webhook payload parsing or transformation (agent receives full raw envelope; any parsing is the agent's job via tool calls)
- Rate limiting per webhook (rely on external service's retry logic and task queueing)
- Webhook delivery history view (use messages table filtered by thread)
- Multiple secrets per webhook (rotation is sufficient; add if blue-green deployment use case emerges)

### 2.3 Design Decisions

**Why HMAC-SHA256 only (no Ed25519, no bearer tokens)?** GitHub, Stripe, Slack, GitLab, and most modern webhook providers use HMAC-SHA256. Discord uses Ed25519 but connects via persistent gateway, not webhooks. Bearer tokens are simpler to implement but lack request integrity (an intercepted token can replay any payload; HMAC binds secret to specific body). If user demand for Ed25519 emerges (e.g., webhooks from Discord-compatible services), add a fifth format.

**Why four signature formats instead of one?** Vendor formats are not interchangeable. GitHub hashes raw body. Stripe hashes `timestamp.body` and enforces timestamp freshness. Slack hashes `version:timestamp:body`. Supporting all four avoids forcing users to deploy a webhook normalization proxy. The implementation cost is low (format detection is header-based, payload construction is format-specific string concatenation).

**Why structured envelope instead of raw body?** The agent needs request context (event-type headers like `X-GitHub-Event`, delivery IDs for deduplication, content type) to interpret payloads. Structured envelope surfaces this without requiring the agent to parse HTTP headers. The alternative (raw body + agent parses headers from synthetic message metadata) pushes HTTP protocol knowledge into agent prompt, which is fragile.

**Why one thread per webhook?** Each webhook endpoint represents a distinct event source. Separate threads isolate conversation histories (GitHub push events don't pollute Stripe payment conversations). The alternative (one shared webhook thread) would require the agent to mentally partition unrelated event streams, degrading context assembly and summary quality.

**Why one task per webhook?** Each webhook needs independent lifecycle management (pause, resume, delete). Shared task with fan-out would require new task triggering logic. One task per webhook reuses existing event task pattern (trigger_spec: `webhook:<name>`).

**Why `tasks.system_prompt_addition` instead of webhook-specific injection?** Persistent prompt injection is useful beyond webhooks (e.g., scheduled tasks with per-task instructions, MCP-triggered workflows with custom context). Generalizing to `tasks.system_prompt_addition` future-proofs the schema and reuses the existing `systemPromptAddition` infrastructure (ContextParams, volatile context injection) without new code paths. Scheduler and relay processor both read the column when building AgentLoopConfig.

**Why sync server (port 3000) instead of web server (port 3001)?** The sync server listens on `BIND_HOST` (configurable, often `0.0.0.0` for hubs), accepts external connections, and is already Ed25519-authenticated for sync traffic. The web server binds to `localhost` by default (host header validation rejects external requests) and is user-facing, not service-facing. Webhooks are inbound service calls, not user UI interactions. The sync server is the correct ingress point. The `/hooks/webhook/:name` route coexists with `/sync/ws` on the same port.

**Why relay intake instead of direct agent invocation?** Hub-only mode has no local model backends. Direct invocation would fail. Relay intake routing ensures webhook processing lands on a spoke with models. This matches Discord platform event behavior (connector leader writes intake, hub routes to processing host). Consistent intake pipeline across all external event sources simplifies debugging and monitoring.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `webhook-ingestion`.

### 3.1 Ubiquitous

**webhook-ingestion.U1.** The system shall support HMAC-SHA256 signature validation for four formats: GitHub (`X-Hub-Signature-256: sha256=<hex>`, payload is raw body), Stripe (`Stripe-Signature: t=<ts>,v1=<hex>`, payload is `<ts>.<raw_body>`), Slack (`X-Slack-Signature: v0=<hex>`, payload is `v0:<version>:<ts>:<raw_body>`), and raw (`X-Webhook-Signature: <hex>`, payload is raw body). All HMAC comparisons shall use `timingSafeEqual` to prevent timing attacks.

**webhook-ingestion.U2.** When a webhook delivery arrives at `POST /hooks/webhook/:name`, the system shall read the raw request body bytes (unbuffered, not re-serialized), validate the HMAC-SHA256 signature against the stored secret for the named webhook, and return 202 Accepted if valid, 401 Unauthorized if invalid (with no detail in response body), 404 Not Found if webhook name does not exist, 400 Bad Request if body is empty or unreadable, or 404 for non-POST methods.

**webhook-ingestion.U3.** When HMAC validation succeeds, the system shall construct a structured JSON envelope containing `method` (always `"POST"`), `path` (`"/hooks/webhook/:name"`), `headers` (filtered subset including event-type headers like `X-GitHub-Event`, `X-Stripe-Event`, content-type, and delivery IDs; excluding signature headers), `content_type`, and `body` (raw bytes as string), write a relay intake entry with `platform: "webhook"`, `ref_id` set to the webhook's thread ID, and `idempotency_key` derived from delivery ID header if present or deterministic hash of body + timestamp if not, then return 202 Accepted.

**webhook-ingestion.U4.** The system shall enforce timestamp-based replay protection for Stripe and Slack signature formats. Requests with timestamps older than 5 minutes (measured from server clock) shall be rejected with 401 Unauthorized. GitHub and raw formats (no timestamp in signature construction) shall not enforce timestamp windows.

**webhook-ingestion.U5.** The system shall provide a `webhooks` table (synced, LWW conflict resolution) with columns: `id` (deterministic UUID based on name), `site_id`, `name` (unique among non-deleted webhooks via partial index), `secret` (256-bit hex-encoded), `signature_format` (enum: `"github"`, `"stripe"`, `"slack"`, `"raw"`), `thread_id`, `task_id`, `prompt` (custom agent instructions), `description`, `created_at`, `modified_at`, `deleted` (soft delete). All writes shall use `insertRow`/`updateRow`/`softDelete` to generate change_log entries.

**webhook-ingestion.U6.** The system shall add a `system_prompt_addition` column to the `tasks` table (nullable TEXT). When a task is claimed by the scheduler or delegated via relay, the orchestrator shall read `system_prompt_addition` from the task row, inject it into `AgentLoopConfig.systemPromptAddition`, and the context assembly pipeline shall inject it into volatile context before system prompt assembly.

**webhook-ingestion.U7.** When the relay intake processor routes a webhook intake entry to a processing host, the processing host shall locate the user message via `ref_id` (thread ID from webhook intake payload), verify the message exists locally (waiting one additional sync cycle if absent, erroring if still absent after wait), inject `system_prompt_addition` from the owning task into AgentLoopConfig, and invoke the agent loop with the structured envelope as message content.

**webhook-ingestion.U8.** The system shall provide `boundctl webhook create` command. The command shall accept `--name`, `--format` (default: `"github"`), `--description`, and `--prompt` arguments, validate name (lowercase alphanumeric plus hyphen, max 64 chars, no leading/trailing hyphen), generate a 256-bit secret (32 random bytes, hex-encoded, cryptographically secure PRNG), create a thread (`interface: "webhook"`), create an event task (`type: "event"`, `trigger_spec: "webhook:<name>"`, `system_prompt_addition: <prompt>`), create a webhook row, print the secret and URL (`http://<sync-host>:<sync-port>/hooks/webhook/<name>`) once, and return. The secret shall never be logged or displayed again without explicit rotation.

**webhook-ingestion.U9.** The system shall provide `boundctl webhook list` command. The command shall display name, signature format, description, and created date for all non-deleted webhooks. The secret field shall not be displayed.

**webhook-ingestion.U10.** The system shall provide `boundctl webhook delete` command. The command shall accept `--name`, soft-delete the webhook row, cancel the associated task (set `status: "cancelled"`, clear `next_run_at`), and return. The thread and task rows shall remain (soft-deleted task, active thread with message history intact).

**webhook-ingestion.U11.** The system shall provide `boundctl webhook update` command. The command shall accept `--name` (required), `--prompt` (updates `tasks.system_prompt_addition` on linked task), `--description` (updates `webhooks.description`), and `--format` (updates `webhooks.signature_format`). Name and linked thread/task IDs shall be immutable (name change requires delete + recreate; external services have hardcoded URLs).

**webhook-ingestion.U12.** The system shall provide `boundctl webhook rotate-secret` command. The command shall accept `--name`, generate a new 256-bit secret, update `webhooks.secret`, print the new secret and URL once, and return. The old secret shall be immediately invalid (next delivery with old secret returns 401).

**webhook-ingestion.U13.** The system shall provide REST API routes on port 3001: `POST /api/webhooks` (create webhook, request body: `{name, format?, description?, prompt?}`, response includes secret), `GET /api/webhooks` (list all non-deleted webhooks, response excludes secret field), `PATCH /api/webhooks/:id` (update webhook, accepts only `{description?, prompt?, format?}`, ignores or errors on `{name?, thread_id?, task_id?, secret?}`), `DELETE /api/webhooks/:id` (soft-delete webhook, cancels task), `POST /api/webhooks/:id/rotate` (rotate secret, response includes only new secret). All routes shall enforce validation (name format, enum constraints, required fields).

**webhook-ingestion.U14.** The system shall provide a web UI view at `#/webhooks` with list view (DataTable showing name, format, description, created date), create form (name, format select, description, prompt textarea), detail/edit panel (editable description, format, prompt; immutable name), one-time secret display modal on create (monospace secret text, copy button, dismissible), one-time secret display modal on rotate (same UX as create), delete button with confirmation, and navigation tab in TopBar. After dismissing secret modal, the secret shall not be retrievable from the UI (no GET endpoint returns it).

### 3.2 Acceptance Criteria

Acceptance criteria map to test names in the test plan. Each requirement with observable behavior has success and failure-mode scenarios.

#### webhook-ingestion.AC1: HMAC-SHA256 validation

- **AC1.1 Success.** Given a webhook with format `"github"` and a valid GitHub-format signature (`X-Hub-Signature-256: sha256=<computed_hex>`), when a POST delivery arrives, then the system returns 202 Accepted and writes a relay intake entry.
- **AC1.2 Success.** Given a webhook with format `"stripe"` and a valid Stripe-format signature (`Stripe-Signature: t=<ts>,v1=<computed_hex>` with `ts` within 5 minutes), when a POST delivery arrives, then the system returns 202 Accepted.
- **AC1.3 Success.** Given a webhook with format `"slack"` and a valid Slack-format signature (`X-Slack-Signature: v0=<computed_hex>`, `X-Slack-Request-Timestamp` within 5 minutes), when a POST delivery arrives, then the system returns 202 Accepted.
- **AC1.4 Success.** Given a webhook with format `"raw"` and a valid raw-format signature (`X-Webhook-Signature: <computed_hex>`), when a POST delivery arrives, then the system returns 202 Accepted.
- **AC1.5 Failure.** Given any webhook format and an invalid HMAC signature (wrong secret, tampered body, or recomputed hash mismatch), when a POST delivery arrives, then the system returns 401 Unauthorized with JSON body `{"error": "Invalid signature"}` and does not write a relay intake entry.
- **AC1.6 Failure.** Given any webhook format and a missing signature header, when a POST delivery arrives, then the system returns 401 Unauthorized.
- **AC1.7 Failure.** Given Stripe or Slack format and a timestamp older than 5 minutes, when a POST delivery arrives, then the system returns 401 Unauthorized (replay protection).
- **AC1.8 Edge.** Given any valid signature, when comparing expected vs. actual HMAC digest, then the comparison shall use `timingSafeEqual` (constant-time comparison) to prevent timing side-channel attacks.

#### webhook-ingestion.AC2: HTTP handler on port 3000

- **AC2.1 Success.** Given a valid webhook and valid signature, when a POST request arrives at `/hooks/webhook/:name`, then the system writes a relay intake entry with `platform: "webhook"`, `ref_id` matching webhook's thread ID, structured envelope payload, and returns 202 Accepted.
- **AC2.2 Failure.** Given a POST request to `/hooks/webhook/:name` where `:name` does not match any non-deleted webhook, then the system returns 404 Not Found.
- **AC2.3 Failure.** Given a POST request with empty body or body read error, when attempting to validate signature, then the system returns 400 Bad Request.
- **AC2.4 Failure.** Given a GET, PUT, PATCH, or DELETE request to `/hooks/webhook/:name`, then the system returns 404 Not Found (only POST is routed).
- **AC2.5 Edge.** Given a POST request, when reading the request body, then raw bytes shall be preserved exactly (not buffered in memory as JSON and re-serialized) before HMAC validation, ensuring signature validation operates on the same bytes the sender signed.
- **AC2.6 Edge.** Given the sync server listening on port 3000 with both `/sync/ws` WebSocket endpoint and `/hooks/webhook/:name` HTTP route, when WebSocket and HTTP clients connect simultaneously, then both connections shall function correctly (no port conflict, no handler interference).

#### webhook-ingestion.AC3: Relay delivery + agent invocation

- **AC3.1 Success.** Given a relay intake entry with `platform: "webhook"` and valid `ref_id` (thread ID), when the hub routes the intake to a processing spoke, then the spoke creates a user message in the webhook's thread with structured envelope content, reads `system_prompt_addition` from the task row, injects into AgentLoopConfig, and runs the agent loop.
- **AC3.2 Success.** Given a webhook intake entry payload, when the processing host assembles message content, then the content shall be a JSON envelope containing `method: "POST"`, `path: "/hooks/webhook/:name"`, `headers` (filtered to include `X-GitHub-Event`, `X-Stripe-Event`, `X-Slack-Event-Type`, `Content-Type`, delivery ID headers; excluding `X-Hub-Signature-256`, `Stripe-Signature`, `X-Slack-Signature`, `X-Webhook-Signature`), `content_type`, and `body` (raw request body as string).
- **AC3.3 Success.** Given a webhook task with `system_prompt_addition: "Summarize GitHub events"`, when the agent loop starts, then the context assembly pipeline shall inject `"Summarize GitHub events"` into volatile context before the system prompt, and the agent shall receive the custom instruction.
- **AC3.4 Success.** Given two webhook deliveries with the same `idempotency_key` (e.g., GitHub redelivery with same `X-GitHub-Delivery` header), when both arrive within 5 minutes, then the relay intake processor shall discard the second delivery silently (idempotency dedup via hub cache).
- **AC3.5 Edge.** Given a hub-only deployment (no local model backends, `modelBackends.backends: []`) and a webhook delivery, when the intake routes to a spoke, then the spoke processes the delivery normally (hub does not attempt local agent invocation, which would fail with no models).
- **AC3.6 Edge.** Given a webhook task claimed by the scheduler (not relay-delegated), when the task runs, then the scheduler shall read `system_prompt_addition` from the task row and inject into AgentLoopConfig (verifies `system_prompt_addition` works for all task invocation paths, not just relay).

#### webhook-ingestion.AC4: boundctl webhook commands

- **AC4.1 Success.** Given `boundctl webhook create --name test-hook --format github --description "Test" --prompt "Handle events"`, when the command runs, then the system generates a 256-bit secret (64-char hex string), creates a thread, task, and webhook row, prints the secret and URL once to stdout, and the secret is stored in `webhooks.secret` for future validation.
- **AC4.2 Success.** Given `boundctl webhook list`, when the command runs, then stdout shows a table with columns Name, Format, Description, Created (no Secret column), listing all non-deleted webhooks.
- **AC4.3 Success.** Given `boundctl webhook delete --name test-hook`, when the command runs, then `webhooks.deleted` is set to 1, the linked task's status is set to `"cancelled"`, and the webhook no longer appears in `boundctl webhook list`.
- **AC4.4 Success.** Given `boundctl webhook update --name test-hook --prompt "New instructions"`, when the command runs, then the linked task's `system_prompt_addition` is updated to `"New instructions"`, and subsequent deliveries invoke the agent with the new prompt.
- **AC4.5 Success.** Given `boundctl webhook rotate-secret --name test-hook`, when the command runs, then a new 256-bit secret is generated, `webhooks.secret` is updated, the new secret is printed once to stdout, and the old secret is immediately invalid (next delivery with old secret returns 401).
- **AC4.6 Failure.** Given `boundctl webhook create --name "Invalid-Name"` (uppercase letters) or `--name "a"` (too short) or `--name "a-very-long-name-exceeding-sixty-four-characters-limit"`, when the command runs, then the system returns a validation error and does not create the webhook.
- **AC4.7 Failure.** Given `boundctl webhook create --name existing-hook` where a non-deleted webhook named `existing-hook` already exists, when the command runs, then the system returns a conflict error (duplicate name).

#### webhook-ingestion.AC5: Web API routes (port 3001)

- **AC5.1 Success.** Given `POST /api/webhooks` with body `{name: "api-hook", format: "github", description: "API test", prompt: "Handle"}`, when the request completes, then the response status is 201 Created, the response body includes `{id, name, format, description, secret, thread_id, task_id, created_at}`, and the secret is a 64-char hex string.
- **AC5.2 Success.** Given `GET /api/webhooks`, when the request completes, then the response status is 200 OK, the response body is an array of webhook objects, and each object excludes the `secret` field.
- **AC5.3 Success.** Given `PATCH /api/webhooks/:id` with body `{description: "Updated", prompt: "New", format: "stripe"}`, when the request completes, then the response status is 200 OK, the webhook's description, prompt (on task row), and format are updated, and immutable fields (name, thread_id, task_id, secret) are unchanged.
- **AC5.4 Success.** Given `DELETE /api/webhooks/:id`, when the request completes, then the response status is 200 OK, the webhook is soft-deleted (`deleted: 1`), and the linked task is cancelled.
- **AC5.5 Success.** Given `POST /api/webhooks/:id/rotate`, when the request completes, then the response status is 200 OK, the response body includes only `{secret: "<new_64_char_hex>"}`, and the old secret is immediately invalid.
- **AC5.6 Failure.** Given `GET /api/webhooks/:id` (not documented in requirements but implied as unsupported), when the request is made, then the response either returns 404 (route not implemented) or 200 with a body that does NOT include the `secret` field.
- **AC5.7 Failure.** Given `PATCH /api/webhooks/:id` with body `{name: "new-name", secret: "spoofed"}`, when the request completes, then the response either ignores the non-editable fields (name, secret remain unchanged) or returns 400 Bad Request with validation error.

#### webhook-ingestion.AC6: Web UI (full CRUD)

- **AC6.1 Success.** Given the user navigates to `#/webhooks`, when the view loads, then a DataTable displays all non-deleted webhooks with columns Name, Format, Description, Created (no Secret column).
- **AC6.2 Success.** Given the user clicks "Create Webhook" button, fills in name/format/description/prompt, and submits, when creation completes, then a modal displays the 64-char hex secret in monospace font with a copy button, and the secret is only shown this once.
- **AC6.3 Success.** Given the user clicks a webhook row in the list to open detail view, edits the description field, and clicks Save, when the update completes, then the description is persisted (verified by reload showing new value).
- **AC6.4 Success.** Given the user clicks "Rotate Secret" button in detail view, when rotation completes, then a modal displays the new 64-char hex secret with a copy button.
- **AC6.5 Success.** Given the user clicks "Delete" button in detail view and confirms, when deletion completes, then the webhook disappears from the list and does not reappear on page reload.
- **AC6.6 Success.** Given the user opens the web UI, when the TopBar renders, then a "Webhooks" navigation tab is visible and clickable (navigates to `#/webhooks`).
- **AC6.7 Edge.** Given the user dismisses the secret modal (create or rotate), when the detail view renders again, then the secret is not visible anywhere in the UI (no GET endpoint returns it, no client state retains it).

---

## 4. Implementation Notes

### 4.1 Sequencing

Implementation follows six phases (see source material for detailed phase breakdown):

1. **Schema + Sync Registration** — `webhooks` table, `tasks.system_prompt_addition` column, sync infrastructure wiring. Idempotent migrations, partial unique index on `webhooks.name WHERE deleted = 0`.
2. **HMAC Validation + HTTP Handler** — Signature extraction per format, timing-safe comparison, webhook HTTP handler on sync server (port 3000), response codes per requirements.
3. **Relay Intake + Agent Delivery** — Relay inbox write, event bus trigger, scheduler `system_prompt_addition` wiring, relay processor wiring, end-to-end message flow.
4. **boundctl Commands** — Five CLI commands (create, list, delete, update, rotate-secret), name validation, deterministic UUID generation, secret display UX.
5. **Web API Routes** — REST endpoints on port 3001, secret filtering (only in create/rotate responses), validation, error handling.
6. **BoundClient SDK + Web UI** — Client methods, Svelte view with DataTable, create form, detail panel, secret modals (one-time display), navigation tab.

All phases completed and merged as of 2026-05-17.

### 4.2 HMAC Payload Construction by Format

| Format | Signature Header | Payload Construction | Timestamp Validation |
|--------|------------------|----------------------|----------------------|
| GitHub | `X-Hub-Signature-256: sha256=<hex>` | Raw body bytes | None |
| Stripe | `Stripe-Signature: t=<ts>,v1=<hex>` | `<timestamp>.<raw_body>` | ≤ 5 minutes |
| Slack | `X-Slack-Signature: v0=<hex>` | `v0:<version>:<timestamp>:<raw_body>` | ≤ 5 minutes (from `X-Slack-Request-Timestamp`) |
| Raw | `X-Webhook-Signature: <hex>` | Raw body bytes | None |

All formats use SHA-256 as the HMAC hash function. Secret is stored as hex-encoded string, converted to Buffer for HMAC computation.

### 4.3 Filtered Headers in Envelope

Included headers (case-insensitive matching, original casing preserved):
- Event-type headers: `X-GitHub-Event`, `X-GitHub-Delivery`, `X-Stripe-Event`, `X-Slack-Event-Type`, `X-Slack-Request-Timestamp`, etc.
- Content metadata: `Content-Type`, `Content-Length`, `User-Agent`
- Delivery IDs: `X-Delivery-ID`, `X-Request-ID`, `X-Correlation-ID`, etc.

Excluded headers:
- Signature headers: `X-Hub-Signature-256`, `Stripe-Signature`, `X-Slack-Signature`, `X-Webhook-Signature` (already validated, no need to expose secret-related data to agent)
- Standard HTTP noise: `Host`, `Connection`, `Accept-Encoding`, `Accept`, `Referer`, `Origin` (no value to agent)

### 4.4 Deterministic UUID Generation

Webhook ID is `UUID5(BOUND_NAMESPACE, name)` where `BOUND_NAMESPACE` is the project's global UUID namespace (defined in `@bound/shared/src/types.ts`). Same name always produces same UUID. Prevents sync conflicts when multiple hosts create the same webhook concurrently (LWW reducer reconciles via `modified_at`, but deterministic ID ensures both hosts produce the same row after sync).

### 4.5 Secret Storage and Rotation UX

Secrets are stored in plaintext in `webhooks.secret` because HMAC validation requires the raw secret (not a hash). Access control relies on database permissions and host-level security (same as MCP server credentials, LLM API keys). The "show once" UX (CLI prints to stdout once, web UI modal dismissible, no GET endpoint) reduces casual exposure but does not prevent database reads by authorized operators.

Rotation generates a new secret and immediately invalidates the old one. No grace period for dual-secret validation (would require schema change to `secrets: TEXT[]` or separate `webhook_secrets` table). Operators must update external service webhook configuration immediately after rotation. If rotation happens mid-delivery, in-flight deliveries with old secret fail with 401; external service retries with same (old) secret also fail until operator updates webhook URL secret in external service.

### 4.6 Relay Intake Routing

Webhook intake entries have `platform: "webhook"`, no host affinity (unlike `platform: "discord"` which has Tier 0 connector affinity in `selectIntakeHost()`). Hub applies standard four-tier routing:

1. **Thread affinity:** If an agent loop is currently active for the webhook's thread (tracked via `status_forward` messages), route to that host.
2. **Model match:** Route to a host that has the thread's selected model locally (from `threads.model_hint` × `hosts.models`). Avoids inference relay latency.
3. **Tool match:** If the thread's last 10 tool calls referenced specific MCP tools (from `messages.tool_name`), route to the host with the majority of those tools (from `hosts.mcp_tools`). Avoids tool relay latency.
4. **Fallback:** Among all hosts synced within `2 × sync_interval`, pick the one with fewest pending relay messages in hub's outbox (load balancing).

This is identical to Discord intake routing except for the absence of Tier 0 (no connector affinity for webhooks; any host can process).

### 4.7 Testing Strategy

- **Unit tests:** HMAC validation (all four formats, success and failure cases, timing-safe comparison), webhook HTTP handler (status codes, body preservation, idempotency), relay intake payload construction (envelope structure, header filtering).
- **Integration tests:** End-to-end webhook delivery (POST → relay write → message creation → agent invocation with `system_prompt_addition`), hub-only routing (verify relay path, not local execution), duplicate delivery dedup (same idempotency key).
- **CLI tests:** All five `boundctl webhook` commands, name validation, secret display, conflict errors.
- **Web API tests:** All REST endpoints, secret filtering (present in create/rotate, absent in list/get), validation errors, soft delete cascading to task cancellation.
- **Web UI tests:** Manual testing only (Svelte component rendering, modal UX, navigation integration). See test plan for manual steps.

Automated test coverage: AC1 (HMAC), AC2 (HTTP handler), AC3 (relay delivery), AC4 (boundctl), AC5 (web API). Manual coverage: AC6 (web UI).

---

## 5. Open Questions

No unresolved questions. All design decisions finalized and implementation completed.

---

## 6. Migration

### 6.1 Schema Changes

**New table:** `webhooks` (synced, LWW, deterministic UUID, partial unique index on name WHERE deleted = 0). No data migration required (table is new).

**New column:** `tasks.system_prompt_addition` (nullable TEXT). No data migration required (existing rows have NULL, which is valid). Future tasks populate the column as needed.

**Idempotent migrations:** Both schema changes are idempotent (CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS). Hosts can upgrade independently without coordinated deployment.

### 6.2 Backwards Compatibility

**Synced table:** The `webhooks` table is added to `SYNCED_TABLE_NAMES`, `TABLE_REDUCER_MAP` (LWW), and `SNAPSHOT_TABLE_ORDER`. Pre-upgrade hosts ignore the table (sync protocol skips unknown tables). Post-upgrade hosts replicate webhook rows normally. No version skew issues.

**New column:** `tasks.system_prompt_addition` is nullable. Pre-upgrade scheduler and relay processor ignore the column (SELECT * still works, NULL is valid). Post-upgrade code reads the column and injects if non-NULL. Mixed-version clusters work correctly (pre-upgrade hosts skip custom prompts, post-upgrade hosts apply them).

**HTTP route:** The `/hooks/webhook/:name` route is new. Pre-upgrade sync servers return 404 for webhook POSTs (no route registered). Post-upgrade sync servers accept webhook POSTs. External services retry on 404 (standard webhook behavior), so deliveries succeed once all hubs are upgraded. No data loss (relay intake is idempotent via idempotency key).

**CLI commands:** `boundctl webhook` commands require upgraded `boundctl` binary. Pre-upgrade `boundctl` returns "unknown command" error. Post-upgrade `boundctl` works against any database schema (commands are schema-aware, handle missing table gracefully with actionable error). Operators upgrade `boundctl` binary independently.

### 6.3 Rollback Considerations

Rolling back after webhook creation is safe but leaves orphaned rows:

- **Orphaned webhooks table:** If rolled back before webhooks are created, no issue (table is empty). If rolled back after creation, webhook rows remain in database but are unused (no HTTP handler processes deliveries, no relay intake written). Soft-delete via `UPDATE webhooks SET deleted = 1 WHERE 1` cleans up.
- **Orphaned tasks.system_prompt_addition:** Pre-rollback tasks with non-NULL `system_prompt_addition` continue to function (column is ignored by pre-upgrade scheduler). Post-rollback, the column remains in schema but is unused. Safe (nullable column with no foreign key constraints).
- **Relay intake entries:** Webhook intake entries written pre-rollback are processed by post-rollback relay processor as unknown platform (logged and skipped, not errored). No crash, no data corruption.

Rollback is non-destructive. Orphaned data can be cleaned up manually if needed.

---

## 7. Glossary

- **HMAC-SHA256** — Hash-based Message Authentication Code using SHA-256 hash function. Computed from shared secret + message payload, proving authenticity (message came from holder of secret) and integrity (message was not tampered with).
- **Timing-safe comparison** — Constant-time comparison that takes the same duration regardless of where two strings differ, preventing timing side-channel attacks on HMAC secrets. Implemented via Node.js `crypto.timingSafeEqual`.
- **Relay intake pipeline** — Existing ingestion flow for external platform events (Discord, webhooks). Connector writes `intake` relay message to hub, hub deduplicates via idempotency cache, routes to target host via tiered affinity rules (thread affinity → model match → tool match → least-loaded), target host writes `process` relay message, processing host creates message and invokes agent loop.
- **Synced table** — Database table whose writes generate change_log entries that replicate across hosts via sync protocol. Must use `insertRow`/`updateRow`/`softDelete` (never raw SQL), must define conflict resolution strategy (LWW or append-only).
- **LWW (last-write-wins)** — Conflict resolution strategy where the row with the latest `modified_at` timestamp wins during sync replay. Used for tables where the most recent state is authoritative (e.g., webhooks, tasks, threads).
- **Deterministic UUID** — UUID generated via UUID v5 (namespace + name → SHA-1 hash → UUID), producing identical ID for identical inputs. Prevents sync conflicts when multiple hosts create the same entity concurrently.
- **Soft delete** — Setting `deleted = 1` rather than physically removing a row. Allows sync protocol to propagate deletions (DELETE would create tombstones; UPDATE with deleted=1 is simpler). Queries filter `WHERE deleted = 0` to exclude soft-deleted rows.
- **Idempotency key** — Deterministic hash of request payload used to detect and discard duplicate deliveries. Stored in hub-side idempotency cache (5-minute TTL). Duplicate requests (same key) return cached response without re-execution.
- **Event task** — Task with `type: "event"` and `trigger_spec` matching an event bus event (e.g., `"webhook:<name>"`). Scheduler claims and executes event tasks when matching events fire on the event bus.
- **system_prompt_addition** — Optional text field on tasks and AgentLoopConfig that injects custom instructions into volatile context before system prompt. Sourced from `tasks.system_prompt_addition` for persistent tasks, or ephemeral context for WebSocket-driven loops.
- **Structured envelope** — JSON object wrapping raw webhook payload with HTTP metadata: `{method, path, headers, content_type, body}`. Preserves full request context for agent interpretation without requiring agent to parse HTTP headers.
- **Signature format** — Enum field (`"github"`, `"stripe"`, `"slack"`, `"raw"`) specifying which HMAC signature scheme a webhook expects. Determines signature header name, payload construction, and timestamp validation behavior.
- **Hub-only mode** — Deployment where hub host has no local model backends (`modelBackends.backends: []`). All agent loops route to spokes via relay. Webhook deliveries route through intake pipeline to spokes, not local execution.
