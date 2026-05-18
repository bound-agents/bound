# Webhook Ingestion Implementation Plan — Phase 2

**Goal:** Port 3000 accepts POST `/webhook/:name`, validates HMAC-SHA256 signatures across four formats, returns appropriate HTTP status codes.

**Architecture:** New HMAC validation module (`packages/web/src/server/webhook-handler.ts`) with format-specific signature extraction and timing-safe comparison. Integrated into the existing `createSyncServer()` fetch handler in `packages/web/src/server/start.ts` alongside the existing WebSocket upgrade path.

**Tech Stack:** Node.js `crypto` module (createHmac, timingSafeEqual), Bun.serve fetch handler, bun:sqlite

**Scope:** 6 phases from original design (this is phase 2 of 6)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

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

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create HMAC validation module

**Verifies:** webhook-ingestion.AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7, AC1.8

**Files:**
- Create: `packages/web/src/server/webhook-hmac.ts`

**Implementation:**

Create a module that exports a single validation function. The module handles four signature formats:

| Format | Header | Signed Payload | Replay Protection |
|--------|--------|---------------|-------------------|
| github | `X-Hub-Signature-256: sha256=<hex>` | Raw body | None |
| stripe | `Stripe-Signature: t=<ts>,v1=<hex>` | `<timestamp>.<body>` | 5-minute window |
| slack | `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp: <unix>` | `v0:<timestamp>:<body>` | 5-minute window |
| raw | `X-Webhook-Signature: <hex>` | Raw body | None |

The function signature:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureFormat } from "@bound/shared";

export interface HmacValidationResult {
	valid: boolean;
}

const REPLAY_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

export function validateWebhookSignature(
	format: SignatureFormat,
	secret: string,
	headers: Headers,
	rawBody: Buffer,
): HmacValidationResult
```

Key requirements:
- All formats compute HMAC-SHA256 using `createHmac("sha256", secret).update(payload).digest("hex")`
- All comparisons use `timingSafeEqual` on equal-length buffers (AC1.8)
- GitHub: extract hex after `sha256=` prefix from `X-Hub-Signature-256` header
- Stripe: parse `t=` and `v1=` from `Stripe-Signature` header, signed payload is `${timestamp}.${rawBody}`
- Slack: extract hex after `v0=` from `X-Slack-Signature`, timestamp from `X-Slack-Request-Timestamp`, signed payload is `v0:${timestamp}:${rawBody}`
- Raw: read hex directly from `X-Webhook-Signature` header
- Missing headers return `{ valid: false }` (AC1.6)
- Stripe/Slack stale timestamps (>5 min) return `{ valid: false }` (AC1.7)
- `timingSafeEqual` requires buffers of equal length — if signature hex length doesn't match expected digest length (64 hex chars for SHA-256), return invalid immediately

**Testing:**

Tests must verify each AC listed above:
- webhook-ingestion.AC1.1: GitHub format with valid signature returns `{ valid: true }`
- webhook-ingestion.AC1.2: Stripe format with valid `t=` and `v1=` returns `{ valid: true }`
- webhook-ingestion.AC1.3: Slack format with valid signature and fresh timestamp returns `{ valid: true }`
- webhook-ingestion.AC1.4: Raw format with valid hex returns `{ valid: true }`
- webhook-ingestion.AC1.5: All formats with incorrect HMAC hex return `{ valid: false }`
- webhook-ingestion.AC1.6: All formats with missing signature header return `{ valid: false }`
- webhook-ingestion.AC1.7: Stripe with timestamp >5 min ago returns `{ valid: false }`; Slack with timestamp >5 min ago returns `{ valid: false }`
- webhook-ingestion.AC1.8: Verify `timingSafeEqual` is used (structural — check that the function imports and calls it; functional — verify wrong-length signatures don't crash)

Test file: `packages/web/src/server/__tests__/webhook-hmac.test.ts`

Follow project patterns: real crypto (no mocking), compute expected HMACs in tests using the same `createHmac` API to build known-good signatures, then verify the validator agrees.

**Verification:**

Run: `bun test packages/web/src/server/__tests__/webhook-hmac.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add HMAC-SHA256 webhook signature validation module`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create webhook HTTP handler

**Verifies:** webhook-ingestion.AC2.1, AC2.2, AC2.3, AC2.4, AC2.5, AC2.6

**Files:**
- Create: `packages/web/src/server/webhook-handler.ts`
- Modify: `packages/web/src/server/start.ts` (lines 167-177, the fetch handler inside `createSyncServer`)

**Implementation:**

Create a handler function that:
1. Extracts webhook name from URL path (`/webhook/<name>`)
2. Looks up webhook row from DB (`SELECT * FROM webhooks WHERE name = ? AND deleted = 0`)
3. Reads raw body as Buffer (AC2.5 — preserve exact bytes)
4. Validates HMAC signature via the module from Task 1
5. On success: builds structured JSON envelope, writes relay_inbox entry, returns 202
6. On failure: returns appropriate error code with no detail body

```typescript
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertInbox } from "@bound/core";
import type { Webhook } from "@bound/shared";
import { validateWebhookSignature } from "./webhook-hmac.js";

export interface WebhookHandlerDeps {
	db: Database;
	siteId: string;
}

export async function handleWebhookRequest(
	request: Request,
	name: string,
	deps: WebhookHandlerDeps,
): Promise<Response>
```

The handler returns:
- `202 Accepted` (empty body) on success (AC2.1)
- `404 Not found` (empty body) if webhook name not found (AC2.2)
- `400 Bad Request` (empty body) if body is empty or unreadable (AC2.3)
- `401 Unauthorized` (empty body) if signature validation fails (AC1.5)

The structured envelope written as the relay_inbox payload content:
```typescript
const envelope = JSON.stringify({
	method: "POST",
	path: `/webhook/${name}`,
	headers: filterHeaders(request.headers),
	content_type: request.headers.get("content-type") || "application/octet-stream",
	body: rawBody.toString("utf-8"),
});
```

Header filtering includes only: event-type headers (`x-github-event`, `x-github-delivery`, `x-stripe-event`, `x-slack-request-timestamp`), `content-type`, delivery IDs. Excludes signature headers, `host`, `connection`, `content-length`, `accept-encoding`.

Modify `createSyncServer()` fetch handler in `start.ts` to route `/webhook/:name` POST requests:

```typescript
fetch(request: Request, bunServer) {
	const url = new URL(request.url);
	if (url.pathname === "/sync/ws" && request.headers.get("upgrade") === "websocket") {
		return wsHandlers.handleUpgrade(
			request,
			bunServer as Parameters<typeof wsHandlers.handleUpgrade>[1],
		);
	}

	// Webhook route: POST /webhook/:name
	const webhookMatch = url.pathname.match(/^\/webhook\/([a-z0-9][a-z0-9_-]{0,63})$/);
	if (webhookMatch) {
		if (request.method !== "POST") {
			return new Response("Not found", { status: 404 });
		}
		return handleWebhookRequest(request, webhookMatch[1], { db: _db, siteId: config.siteId });
	}

	return new Response("Not found", { status: 404 });
}
```

Note: The `_db` parameter is already declared in `createSyncServer` (line 133) but currently unused — rename to `db` and use it. Similarly `_eventBus` → `eventBus`.

**Testing:**

Tests must verify each AC listed above:
- webhook-ingestion.AC2.1: POST with valid signature → 202 + relay_inbox row exists
- webhook-ingestion.AC2.2: POST to unknown webhook name → 404
- webhook-ingestion.AC2.3: POST with empty body → 400
- webhook-ingestion.AC2.4: GET/PUT/DELETE to `/webhook/:name` → 404
- webhook-ingestion.AC2.5: Body bytes passed to HMAC validator match what was sent (verify by checking the stored envelope body matches)
- webhook-ingestion.AC2.6: WebSocket upgrade to `/sync/ws` still returns 101 (or verify the WS path is unchanged)

Test file: `packages/web/src/server/__tests__/webhook-handler.test.ts`

Setup: Use in-memory SQLite DB with `applySchema(db)`, insert a test webhook row directly, then call `handleWebhookRequest()` with constructed Request objects. Verify relay_inbox entries via direct DB query.

**Verification:**

Run: `bun test packages/web/src/server/__tests__/webhook-handler.test.ts`
Expected: All tests pass

Run: `bun test --recursive`
Expected: Full suite passes (including existing sync/WS tests confirming AC2.6)

**Commit:** `feat(web): add webhook HTTP handler to sync server`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Run full test suite to verify no regressions

**Step 1: Run tests**

Run: `bun test --recursive`
Expected: All tests pass (3392+ passing, 0 failures). Existing WebSocket sync tests must still pass (AC2.6).

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean across all packages

**Step 3: Run lint**

Run: `bun run lint`
Expected: Clean (or fix any formatting issues introduced)

**Commit:** Only if fixes were needed: `fix(web): lint/type fixes for webhook handler`
<!-- END_TASK_3 -->
