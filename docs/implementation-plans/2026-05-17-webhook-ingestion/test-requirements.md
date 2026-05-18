# Test Requirements: Webhook Ingestion

## Automated Tests

### AC1: Webhook HMAC-SHA256 Validation

| Criterion | Type | Test File | Verifies |
|-----------|------|-----------|----------|
| AC1.1 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Valid GitHub-format signature (`X-Hub-Signature-256: sha256=<hex>`) computed from known secret and body returns `{ valid: true }` |
| AC1.2 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Valid Stripe-format signature (`Stripe-Signature: t=<ts>,v1=<hex>`) with fresh timestamp returns `{ valid: true }` |
| AC1.3 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Valid Slack-format signature (`X-Slack-Signature: v0=<hex>`) with valid `X-Slack-Request-Timestamp` within 5-minute window returns `{ valid: true }` |
| AC1.4 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Valid raw-format signature (`X-Webhook-Signature: <hex>`) returns `{ valid: true }` |
| AC1.5 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Incorrect HMAC hex for each format returns `{ valid: false }`; response body contains no diagnostic detail |
| AC1.6 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Missing signature header for each format returns `{ valid: false }` |
| AC1.7 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Stripe signature with timestamp >5 min old returns `{ valid: false }`; Slack signature with `X-Slack-Request-Timestamp` >5 min old returns `{ valid: false }` |
| AC1.8 | unit | `packages/web/src/server/__tests__/webhook-hmac.test.ts` | Wrong-length signature hex does not crash (returns invalid gracefully); structurally verify `timingSafeEqual` import is used (code inspection during review); signatures with length mismatch vs 64-char expected digest return `{ valid: false }` without throwing |

**Test approach:** Compute known-good HMACs in the test using `createHmac("sha256", secret).update(payload).digest("hex")`. No mocking of crypto — real cryptographic operations for correctness.

---

### AC2: HTTP Handler on Port 3000

| Criterion | Type | Test File | Verifies |
|-----------|------|-----------|----------|
| AC2.1 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | POST `/webhook/:name` with valid signature writes a `relay_inbox` row (verified via DB query) and returns HTTP 202 with empty body |
| AC2.2 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | POST `/webhook/nonexistent-name` where no matching webhook row exists returns HTTP 404 with empty body |
| AC2.3 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | POST with empty body (Content-Length: 0 or no body) returns HTTP 400 |
| AC2.4 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | GET, PUT, DELETE to `/webhook/:name` return HTTP 404 |
| AC2.5 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | Envelope body stored in relay_inbox matches the exact raw bytes sent in the request (send known UTF-8 body, verify stored envelope JSON `.body` field matches) |
| AC2.6 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | Existing WebSocket upgrade path (`/sync/ws`) is unchanged; verify the route matching regex does not intercept `/sync/ws` requests (or run full test suite to confirm existing sync tests still pass) |

**Test setup:** In-memory SQLite with `applySchema(db)`, insert a test webhook row directly, call `handleWebhookRequest()` with constructed `Request` objects. Verify relay_inbox entries via direct DB query.

---

### AC3: Relay Delivery + Agent Invocation

| Criterion | Type | Test File | Verifies |
|-----------|------|-----------|----------|
| AC3.1 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | After valid POST, relay_inbox entry contains correct `thread_id` from the webhook row and `kind: "intake"` |
| AC3.2 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | Stored relay_inbox payload is valid JSON with keys: `method`, `path`, `headers`, `content_type`, `body`; `method` is `"POST"`, `path` is `/webhook/<name>`, `headers` excludes signature headers but includes event-type headers |
| AC3.3 | unit | `packages/agent/src/__tests__/relay-processor-webhook.test.ts` | When task row has `system_prompt_addition` set, the SELECT query in `runDelegatedLoop` returns it and the value flows into `AgentLoopConfig.systemPromptAddition` |
| AC3.4 | integration | `packages/web/src/server/__tests__/webhook-handler.test.ts` | Two POST requests with identical `X-GitHub-Delivery` header produce only one relay_inbox entry (second INSERT OR IGNORE is a no-op); POST without delivery header generates a unique ID per request |
| AC3.5 | integration | `packages/agent/src/__tests__/relay-processor-webhook.test.ts` | When no local model backends exist, relay routes to a spoke via the existing `selectIntakeHost()` Tier 2/4 fallback (verified via existing hub-spoke integration test infrastructure or a focused test confirming handleIntake does not error when local default is empty) |
| AC3.6 | unit | `packages/agent/src/__tests__/scheduler-prompt-addition.test.ts` | Scheduler event task execution path reads `system_prompt_addition` from task row and passes it into `AgentLoopConfig.systemPromptAddition`; also verify cron task path includes the same wiring |

**Test setup for AC3.3/AC3.6:** In-memory DB with schema, insert task row with known `system_prompt_addition` value. For AC3.3, verify the relay processor SELECT query returns the field. For AC3.6, verify the scheduler's loopConfig construction includes it.

---

### AC4: boundctl Webhook Commands

| Criterion | Type | Test File | Verifies |
|-----------|------|-----------|----------|
| AC4.1 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookCreate` with valid name creates webhook, task, and thread rows in DB; secret is 64 hex characters; function output includes the secret string |
| AC4.2 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookList` query result does not include `secret` column; output shows name, format, description, created_at |
| AC4.3 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookDelete` sets `webhooks.deleted = 1` and sets associated `tasks.status = "cancelled"` |
| AC4.4 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookUpdate` with `--prompt "new prompt"` updates `tasks.system_prompt_addition` on the linked task row |
| AC4.5 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookRotateSecret` changes `webhooks.secret` in DB to a new 64-char hex value different from the original |
| AC4.6 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookCreate` with uppercase name ("MyHook"), special chars ("my hook!"), or >64 chars throws a validation error |
| AC4.7 | unit | `packages/cli/src/commands/__tests__/webhook.test.ts` | `webhookCreate` called twice with the same name (without delete in between) throws a conflict error on the second call |

**Test setup:** In-memory SQLite with `applySchema(db)`, call command functions directly (not via CLI process), assert DB state.

---

### AC5: Web API Routes (Port 3001)

| Criterion | Type | Test File | Verifies |
|-----------|------|-----------|----------|
| AC5.1 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | POST `/api/webhooks` with valid JSON body returns HTTP 201, response body includes `secret` field (64 hex chars), and webhook/task/thread rows exist in DB |
| AC5.2 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | GET `/api/webhooks` returns JSON array where no element contains a `secret` key |
| AC5.3 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | PATCH `/api/webhooks/:id` with `{ description: "new" }` updates description in DB; PATCH with `{ prompt: "new" }` updates `tasks.system_prompt_addition`; PATCH with `{ format: "stripe" }` updates `webhooks.signature_format` |
| AC5.4 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | DELETE `/api/webhooks/:id` returns HTTP 204, sets `webhooks.deleted = 1`, sets `tasks.status = "cancelled"` |
| AC5.5 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | POST `/api/webhooks/:id/rotate` returns JSON with only a `secret` field (new 64 hex chars), and `webhooks.secret` in DB matches the returned value |
| AC5.6 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | GET `/api/webhooks/:id` response body does NOT contain a `secret` key |
| AC5.7 | integration | `packages/web/src/server/__tests__/webhooks-routes.test.ts` | PATCH `/api/webhooks/:id` with `{ name: "new-name", thread_id: "xxx", secret: "yyy" }` does not change those fields in the DB row |

**Test setup:** In-memory DB with `applySchema(db)`, instantiate `createWebhooksRoutes(db)` as a Hono app, test via `app.fetch(new Request(...))`. Assert response status, body shape, and DB state.

---

### AC6: Web UI (Partial Automated)

| Criterion | Type | Test File | Verifies |
|-----------|------|-----------|----------|
| AC6.6 | unit | `packages/client/src/__tests__/client-webhooks.test.ts` | BoundClient webhook methods (`listWebhooks`, `createWebhook`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`) construct correct fetch URLs and HTTP methods |

**Note:** The BoundClient test verifies the SDK layer underpinning the UI. Svelte component behavior is covered by human verification below.

---

## Human Verification

### AC1: Webhook HMAC-SHA256 Validation

| Criterion | Justification | Verification Approach |
|-----------|--------------|----------------------|
| AC1.8 (supplementary) | Constant-time comparison is a code-correctness property best confirmed by code review | Inspect `webhook-hmac.ts` to confirm all comparison paths use `timingSafeEqual` from `node:crypto`, never `===` or `Buffer.compare` on HMAC digests |

---

### AC2: HTTP Handler on Port 3000

| Criterion | Justification | Verification Approach |
|-----------|--------------|----------------------|
| AC2.6 (supplementary) | Full WebSocket handshake requires a running Bun server with actual socket upgrade | Run `bound start`, connect a sync client or use `wscat` to verify `/sync/ws` upgrade still returns 101. Confirm webhook route does not interfere. Alternatively, verify existing sync integration tests pass in CI. |

---

### AC3: Relay Delivery + Agent Invocation

| Criterion | Justification | Verification Approach |
|-----------|--------------|----------------------|
| AC3.1 (end-to-end) | Full routing through RelayProcessor requires multi-host setup or mock relay processing | Send a real webhook POST to a running hub, verify the spoke processes it: check `messages` table for a row in the webhook's thread with the expected envelope content |
| AC3.5 (end-to-end) | Hub-only routing requires a real multi-host cluster with no local backends on the hub | Deploy hub-only node (no backends), send webhook POST, verify relay_outbox entry targets a spoke. Alternatively, confirm `selectIntakeHost()` existing integration tests cover the no-local-model fallback. |

---

### AC6: Web UI (Full CRUD)

| Criterion | Justification | Verification Approach |
|-----------|--------------|----------------------|
| AC6.1 | UI visual/interactive behavior; project does not unit-test Svelte components | Open web UI, navigate to Webhooks tab. Verify table displays columns: Name, Format, Description, Created. Create 2+ webhooks via CLI, confirm they appear. |
| AC6.2 | Modal display with one-time secret requires browser interaction | Click "Create Webhook", fill form, submit. Verify modal appears with secret string in monospace, copy button copies to clipboard (paste to verify). |
| AC6.3 | Form editing requires visual verification of field bindings | Click a webhook row, verify detail panel shows description, format (select), and prompt (textarea). Edit each field, save, reload page, confirm changes persisted. |
| AC6.4 | Secret rotation modal is a transient UI state | In detail view, click "Rotate Secret". Verify modal shows new secret, copy works. Dismiss modal, confirm secret is no longer visible anywhere in the UI. |
| AC6.5 | Confirmation dialog and list refresh are interactive behaviors | In detail view, click "Delete". Verify browser `confirm()` dialog appears. Accept it, verify webhook disappears from list. |
| AC6.6 | Navigation integration is a visual/routing concern | Verify "Webhooks" tab appears in TopBar. Click it, confirm route changes to `#/webhooks` and WebhookView renders. |
| AC6.7 | One-time secret display is a UX guarantee requiring interaction | After creating a webhook, dismiss the secret modal. Refresh the page. Navigate to the webhook detail view. Confirm no secret is visible. Call GET `/api/webhooks/:id` directly, confirm no `secret` field in response. |

---

## Test Summary

| AC Group | Automated Tests | Human Verification |
|----------|----------------|-------------------|
| AC1: HMAC Validation | 8 criteria (unit) | 1 supplementary code review |
| AC2: HTTP Handler | 6 criteria (integration) | 1 supplementary live verification |
| AC3: Relay + Agent | 6 criteria (unit + integration) | 2 end-to-end multi-host |
| AC4: boundctl Commands | 7 criteria (unit) | 0 |
| AC5: Web API Routes | 7 criteria (integration) | 0 |
| AC6: Web UI | 1 criterion (unit, BoundClient) | 7 criteria (manual) |

**Total:** 35 automated test assertions across 6 test files, 11 human verification items.

### Test File Inventory

| File | Package | Type | Covers |
|------|---------|------|--------|
| `packages/web/src/server/__tests__/webhook-hmac.test.ts` | @bound/web | unit | AC1.1-AC1.8 |
| `packages/web/src/server/__tests__/webhook-handler.test.ts` | @bound/web | integration | AC2.1-AC2.6, AC3.1-AC3.2, AC3.4 |
| `packages/agent/src/__tests__/relay-processor-webhook.test.ts` | @bound/agent | unit/integration | AC3.3, AC3.5 |
| `packages/agent/src/__tests__/scheduler-prompt-addition.test.ts` | @bound/agent | unit | AC3.6 |
| `packages/cli/src/commands/__tests__/webhook.test.ts` | @bound/cli | unit | AC4.1-AC4.7 |
| `packages/web/src/server/__tests__/webhooks-routes.test.ts` | @bound/web | integration | AC5.1-AC5.7 |
| `packages/client/src/__tests__/client-webhooks.test.ts` | @bound/client | unit | AC6 (SDK layer) |
