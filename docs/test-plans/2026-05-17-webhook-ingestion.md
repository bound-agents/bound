# Webhook Ingestion — Human Test Plan

Generated from automated test analysis of acceptance criteria AC1-AC6.

## Prerequisites

- `bound` binary built and installed from this branch: `bun run build && cp dist/bound* ~/.local/bin/`
- Running instance: `bound start` (or `bun run packages/cli/src/bound.ts start`)
- Access to the web UI at `http://localhost:3001`
- All automated tests passing: `bun test packages/web/src/server/__tests__/webhook-hmac.test.ts packages/web/src/server/__tests__/webhook-handler.test.ts packages/agent/src/__tests__/relay-processor-webhook.test.ts packages/agent/src/__tests__/scheduler-prompt-addition.test.ts packages/cli/src/commands/__tests__/webhook.test.ts packages/web/src/server/__tests__/webhooks-routes.test.ts packages/client/src/__tests__/client-webhooks.test.ts`
- `curl` and `jq` available for CLI verification

## Phase 1: HMAC Code Review (AC1.8 supplementary)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `packages/web/src/server/webhook-hmac.ts` | File exists |
| 2 | Verify import line includes `timingSafeEqual` from `node:crypto` | `import { createHmac, timingSafeEqual } from "node:crypto"` |
| 3 | Search for any `===` comparison on HMAC digest variables | None found — all digest comparisons flow through `timingSafeEqual` |
| 4 | Verify length guard before `timingSafeEqual` call (line ~156) | Code checks buffer lengths match before calling `timingSafeEqual`, returning false for mismatched lengths |

## Phase 2: WebSocket Coexistence (AC2.6 supplementary)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start bound: `bound start` | Server starts, logs show sync listener on port 3000 |
| 2 | Run `wscat -c ws://localhost:3000/sync/ws` (or use a sync client) | WebSocket upgrade succeeds (HTTP 101), connection established |
| 3 | In a separate terminal, send a webhook: `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhook/nonexistent -d '{"test":true}' -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=abc123"` | Returns `404` (webhook not found, but the route responds correctly) |
| 4 | Verify the wscat connection is still alive (send a ping or observe no disconnect) | WebSocket connection remains active, unaffected by the webhook request |

## Phase 3: End-to-End Relay Delivery (AC3.1 e2e)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create a webhook via CLI: `boundctl webhook create --name e2e-test --format github` | Output shows webhook name, URL `/webhook/e2e-test`, and secret |
| 2 | Save the secret from step 1 as `$SECRET` | Secret is a 64-char hex string |
| 3 | Compute HMAC: `echo -n '{"event":"push","ref":"refs/heads/main"}' \| openssl dgst -sha256 -hmac "$SECRET" \| awk '{print $NF}'` | Produces a 64-char hex HMAC |
| 4 | Send webhook: `curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/e2e-test -d '{"event":"push","ref":"refs/heads/main"}' -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$HMAC" -H "X-GitHub-Event: push"` | HTTP 202, empty body |
| 5 | Query the database: `sqlite3 ~/bound/data/bound.db "SELECT ref_id, payload FROM relay_inbox WHERE kind='intake' ORDER BY received_at DESC LIMIT 1"` | `ref_id` matches the webhook's thread_id; `payload` JSON contains `method: "POST"`, `path: "/webhook/e2e-test"`, `body` matching the sent JSON |
| 6 | Wait 10-30 seconds for the agent loop to process the intake entry | Agent processes the webhook payload |
| 7 | Check messages table: `sqlite3 ~/bound/data/bound.db "SELECT content FROM messages WHERE thread_id = (SELECT thread_id FROM webhooks WHERE name = 'e2e-test') ORDER BY created_at DESC LIMIT 3"` | Messages exist in the webhook's thread containing the envelope data |

## Phase 4: Hub-Only Relay Routing (AC3.5 e2e)

| Step | Action | Expected |
|------|--------|----------|
| 1 | On a hub-only node (no local model backends, `backends: []`), create a webhook: `boundctl webhook create --name hub-webhook --format raw` | Webhook created successfully |
| 2 | Compute HMAC and send: `curl -X POST http://<hub>:3000/webhook/hub-webhook -d '{"data":"test"}' -H "X-Webhook-Signature: $HMAC" -H "Content-Type: application/json"` | HTTP 202 |
| 3 | Check relay_outbox on hub: `sqlite3 <hub-db> "SELECT target_site_id, kind FROM relay_outbox ORDER BY created_at DESC LIMIT 1"` | Entry targets a spoke (non-local site_id) with kind `intake` |
| 4 | On the spoke, check relay_inbox: `sqlite3 <spoke-db> "SELECT ref_id, payload FROM relay_inbox WHERE kind='intake' ORDER BY received_at DESC LIMIT 1"` | Entry arrived with correct thread_id and payload |

## Phase 5: Web UI CRUD (AC6.1-AC6.7)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `http://localhost:3001` in browser | Web UI loads |
| 2 | Look for "Webhooks" tab in the top navigation bar | Tab is visible |
| 3 | Click "Webhooks" tab | Route changes to `#/webhooks`, WebhookView component renders with a table (may be empty) |
| 4 | Click "Create Webhook" button | A form appears with fields: Name, Format (select), Description, Prompt |
| 5 | Fill in: Name=`ui-test-hook`, Format=`github`, Description=`Test from UI`, Prompt=`Handle events` | Fields accept input |
| 6 | Submit the form | Modal appears showing the secret in monospace font; copy button visible |
| 7 | Click the copy button, paste into a text editor | Pasted value matches the displayed 64-char hex secret |
| 8 | Dismiss the secret modal | Secret is no longer visible anywhere in the UI |
| 9 | Verify the new webhook appears in the table with columns: Name (`ui-test-hook`), Format (`github`), Description (`Test from UI`), Created (today's date) | Row present with correct values |
| 10 | Click the webhook row to open detail view | Detail panel shows description, format select, and prompt textarea with the values entered |
| 11 | Edit the description to `Updated description`, click Save | Success feedback, page reloads or refreshes showing new value |
| 12 | Reload the page, navigate back to the webhook detail | Description shows `Updated description` (persisted) |
| 13 | In detail view, click "Rotate Secret" | A modal appears showing the new secret |
| 14 | Dismiss the rotation modal | Secret no longer visible in the detail view |
| 15 | In detail view, click "Delete" | Browser `confirm()` dialog appears |
| 16 | Accept the confirmation | Webhook disappears from the list |
| 17 | Refresh the page | Webhook does not reappear in the list |
| 18 | Call `curl http://localhost:3001/api/webhooks` directly | JSON response does not contain the deleted webhook |
| 19 | Call `curl http://localhost:3001/api/webhooks/<id-from-step-5>` | Returns 404 or does not include a `secret` field |

## End-to-End: Full Webhook Lifecycle

Validates the complete path from webhook creation through external event delivery to agent processing.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create webhook via web UI: name=`lifecycle-test`, format=`github`, prompt=`Summarize the GitHub push event` | Webhook created, secret shown |
| 2 | Note the secret from the creation modal | 64-char hex string |
| 3 | From an external terminal, compute HMAC and POST a realistic GitHub push payload to `http://<host>:3000/webhook/lifecycle-test` | HTTP 202 |
| 4 | Open the web UI, navigate to the webhook's associated thread | Thread exists with webhook payload |
| 5 | Verify the agent received the webhook payload and responded according to the prompt instruction | Agent response references the push event |
| 6 | Rotate the secret via the web UI | New secret shown |
| 7 | Re-send the same webhook with the OLD secret | HTTP 401 |
| 8 | Compute new HMAC with the rotated secret | HTTP 202 |
| 9 | Delete the webhook via the web UI | Webhook removed |
| 10 | Send another POST to `/webhook/lifecycle-test` | HTTP 404 |

## Traceability Matrix

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | webhook-hmac.test.ts "AC1.1" | — |
| AC1.2 | webhook-hmac.test.ts "AC1.2" | — |
| AC1.3 | webhook-hmac.test.ts "AC1.3" | — |
| AC1.4 | webhook-hmac.test.ts "AC1.4" | — |
| AC1.5 | webhook-hmac.test.ts "AC1.5" (x4) | — |
| AC1.6 | webhook-hmac.test.ts "AC1.6" (x4) | — |
| AC1.7 | webhook-hmac.test.ts "AC1.7" (x2) | — |
| AC1.8 | webhook-hmac.test.ts "AC1.8" | Phase 1 steps 1-4 |
| AC2.1 | webhook-handler.test.ts "AC2.1" | Phase 3 steps 4-5 |
| AC2.2 | webhook-handler.test.ts "AC2.2" | — |
| AC2.3 | webhook-handler.test.ts "AC2.3" | — |
| AC2.4 | webhook-handler.test.ts "AC2.4" | — |
| AC2.5 | webhook-handler.test.ts "AC2.5" | — |
| AC2.6 | webhook-handler.test.ts "AC2.6" | Phase 2 steps 1-4 |
| AC3.1 | webhook-handler.test.ts "AC2.1" (ref_id) | Phase 3 steps 5-7 |
| AC3.2 | webhook-handler.test.ts "AC3.2" (x3) | — |
| AC3.3 | relay-processor-webhook.test.ts "AC3.3" | — |
| AC3.4 | webhook-handler.test.ts "AC3.4" | — |
| AC3.5 | relay-processor-webhook.test.ts "AC3.5" | Phase 4 steps 1-4 |
| AC3.6 | scheduler-prompt-addition.test.ts "AC3.6" | — |
| AC4.1 | webhook.test.ts "webhookCreate" | — |
| AC4.2 | webhook.test.ts "webhookList" | — |
| AC4.3 | webhook.test.ts "webhookDelete" | — |
| AC4.4 | webhook.test.ts "webhookUpdate" | — |
| AC4.5 | webhook.test.ts "webhookRotateSecret" | — |
| AC4.6 | webhook.test.ts (validation errors) | — |
| AC4.7 | webhook.test.ts (duplicate name) | — |
| AC5.1 | webhooks-routes.test.ts "AC5.1" | — |
| AC5.2 | webhooks-routes.test.ts "AC5.2" | — |
| AC5.3 | webhooks-routes.test.ts "AC5.3" | — |
| AC5.4 | webhooks-routes.test.ts "AC5.4" | — |
| AC5.5 | webhooks-routes.test.ts "AC5.5" | — |
| AC5.6 | webhooks-routes.test.ts "AC5.6" | — |
| AC5.7 | webhooks-routes.test.ts "AC5.7" | — |
| AC6.1 | — | Phase 5 steps 2-3 |
| AC6.2 | — | Phase 5 steps 4-8 |
| AC6.3 | — | Phase 5 steps 10-12 |
| AC6.4 | — | Phase 5 steps 13-14 |
| AC6.5 | — | Phase 5 steps 15-17 |
| AC6.6 | client-webhooks.test.ts "AC6.6" | Phase 5 steps 2-3 |
| AC6.7 | — | Phase 5 steps 8, 18-19 |
