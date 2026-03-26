# Inference Relay Implementation Plan — Phase 1: Schema & Type Foundation

**Goal:** Add streaming relay support to the schema, relay kind constants, entry types, CRUD helpers, and outbox factory — the type foundation everything else builds on.

**Architecture:** Extend the three relay tables with a nullable `stream_id TEXT` column, add five new relay message kinds, define the five new payload interfaces (split across shared and llm packages per dependency boundaries), update entry interfaces and CRUD helpers to carry `stream_id`, and extend `createRelayOutboxEntry()` with an optional `streamId` parameter.

**Tech Stack:** bun:sqlite, TypeScript 6.x strict, bun:test

**Scope:** Phase 1 of 7 (inference-relay)

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

This phase has no acceptance criteria — it is pure infrastructure. Every task below explicitly states **Verifies: None**.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Schema migration — add `stream_id` to relay tables

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/core/src/schema.ts` (add after line 302 — after the existing relay_cycles index)

**Implementation:**

In `applySchema()`, append the following `ALTER TABLE` calls after the existing relay_cycles index block (after line 302). SQLite does not support `ADD COLUMN IF NOT EXISTS`, so wrap each in a try/catch to remain idempotent:

```typescript
// stream_id column migrations (idempotent — ignore if column already exists)
try { db.run(`ALTER TABLE relay_outbox ADD COLUMN stream_id TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE relay_inbox  ADD COLUMN stream_id TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE relay_cycles ADD COLUMN stream_id TEXT`); } catch { /* already exists */ }
```

Then add stream-aware indexes (use `CREATE INDEX IF NOT EXISTS` which is already idempotent):

```typescript
db.run(`
	CREATE INDEX IF NOT EXISTS idx_relay_outbox_stream
	ON relay_outbox(stream_id)
	WHERE stream_id IS NOT NULL
`);

db.run(`
	CREATE INDEX IF NOT EXISTS idx_relay_inbox_stream
	ON relay_inbox(stream_id, processed)
	WHERE stream_id IS NOT NULL AND processed = 0
`);
```

`relay_cycles` does not need a stream_id index — it is queried by `created_at` for metrics only.

**Verification:**

Run: `bun test packages/core/src/__tests__/relay.test.ts`
Expected: All existing relay tests pass (no schema regressions)

Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `feat(core): add stream_id column to relay tables with idempotent migration`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Relay kind constants — add five new kinds

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/shared/src/types.ts` (lines 210–224 — the RELAY_REQUEST_KINDS and RELAY_RESPONSE_KINDS const arrays)

**Implementation:**

Replace the existing kind arrays at lines 210–224 with the extended versions:

```typescript
export const RELAY_REQUEST_KINDS = [
	"tool_call",
	"resource_read",
	"prompt_invoke",
	"cache_warm",
	"cancel",
	"inference",
	"process",
] as const;

export const RELAY_RESPONSE_KINDS = [
	"result",
	"error",
	"stream_chunk",
	"stream_end",
	"status_forward",
] as const;

export const RELAY_KINDS = [...RELAY_REQUEST_KINDS, ...RELAY_RESPONSE_KINDS] as const;

export type RelayRequestKind = (typeof RELAY_REQUEST_KINDS)[number];
export type RelayResponseKind = (typeof RELAY_RESPONSE_KINDS)[number];
export type RelayKind = (typeof RELAY_KINDS)[number];
```

Rationale for placement:
- `inference` and `process` are outbound requests from a requester/orchestrator to a target.
- `stream_chunk`, `stream_end`, `status_forward` are inbound responses from a target back to the requester.
- The existing `cancel` kind (already in RELAY_REQUEST_KINDS) is reused for cancelling inference streams via `ref_id`.

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add inference, process, stream_chunk, stream_end, status_forward relay kinds`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-6) -->

<!-- START_TASK_3 -->
### Task 3: Add `stream_id` field to `RelayOutboxEntry` and `RelayInboxEntry`

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/shared/src/types.ts` (lines 226–249 — RelayOutboxEntry and RelayInboxEntry interfaces)

**Implementation:**

Add `stream_id: string | null` to both interfaces. Insert it after `idempotency_key` in each:

`RelayOutboxEntry` (currently lines 226–237), becomes:
```typescript
export interface RelayOutboxEntry {
	id: string;
	source_site_id: string | null;
	target_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	stream_id: string | null;
	payload: string;
	created_at: string;
	expires_at: string;
	delivered: number;
}
```

`RelayInboxEntry` (currently lines 239–249), becomes:
```typescript
export interface RelayInboxEntry {
	id: string;
	source_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	stream_id: string | null;
	payload: string;
	expires_at: string;
	received_at: string;
	processed: number;
}
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors (downstream packages that use RelayOutboxEntry/RelayInboxEntry will fail until the CRUD helpers in Task 4 are updated — proceed immediately to Task 4)

**No standalone commit** — commit together with Task 4.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update `writeOutbox()` and `insertInbox()` CRUD helpers for `stream_id`

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/core/src/relay.ts` (lines 20–89)

**Implementation:**

Update `writeOutbox()` (lines 20–41) to include `stream_id` in the INSERT:

```typescript
export function writeOutbox(
	db: Database,
	entry: Omit<RelayOutboxEntry, "delivered">,
	maxPayloadBytes: number = MAX_PAYLOAD_BYTES_DEFAULT,
): void {
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	db.run(
		`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, created_at, expires_at, delivered)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[
			entry.id,
			entry.source_site_id,
			entry.target_site_id,
			entry.kind,
			entry.ref_id,
			entry.idempotency_key,
			entry.stream_id,
			entry.payload,
			entry.created_at,
			entry.expires_at,
		],
	);
}
```

Update `insertInbox()` (lines 68–89) to include `stream_id` in the INSERT:

```typescript
export function insertInbox(
	db: Database,
	entry: RelayInboxEntry,
	maxPayloadBytes: number = MAX_PAYLOAD_BYTES_DEFAULT,
): boolean {
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	const result = db.run(
		`INSERT OR IGNORE INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[
			entry.id,
			entry.source_site_id,
			entry.kind,
			entry.ref_id,
			entry.idempotency_key,
			entry.stream_id,
			entry.payload,
			entry.expires_at,
			entry.received_at,
		],
	);
	return result.changes > 0;
}
```

**Verification:**

Run: `bun test packages/core/src/__tests__/relay.test.ts`
Expected: All relay CRUD tests pass

Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `feat(core): add stream_id to RelayOutboxEntry, RelayInboxEntry types and CRUD helpers`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Add `readInboxByStreamId()` CRUD helper

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/core/src/relay.ts` (append after the existing `readInboxByRefId()` at line 116)
- Modify: `packages/core/src/index.ts` (add export for `readInboxByStreamId`)

**Implementation:**

Append `readInboxByStreamId()` after `readInboxByRefId()` in relay.ts:

```typescript
export function readInboxByStreamId(
	db: Database,
	streamId: string,
): RelayInboxEntry[] {
	return db
		.query(
			"SELECT * FROM relay_inbox WHERE stream_id = ? AND processed = 0 ORDER BY received_at ASC",
		)
		.all(streamId) as RelayInboxEntry[];
}
```

Note: Returns ALL unprocessed entries for a given stream_id ordered by `received_at`. The caller (RELAY_STREAM state machine in Phase 3) is responsible for ordering by `seq` from the deserialized payload.

Then check `packages/core/src/index.ts` and add `readInboxByStreamId` to the relay exports if it is not already re-exported.

**Verification:**

Run: `tsc -p packages/core --noEmit`
Expected: No type errors

**Commit:** `feat(core): add readInboxByStreamId CRUD helper`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Add `streamId` parameter to `createRelayOutboxEntry()`

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/relay-router.ts` (lines 86–106)

**Implementation:**

Add an optional `streamId` parameter as the last parameter of `createRelayOutboxEntry()`. The return type `Omit<RelayOutboxEntry, "delivered">` already includes `stream_id` now (from Task 3):

```typescript
export function createRelayOutboxEntry(
	targetSiteId: string,
	kind: string,
	payload: string,
	timeoutMs: number,
	refId?: string,
	idempotencyKey?: string,
	streamId?: string,
): Omit<RelayOutboxEntry, "delivered"> {
	const now = new Date();
	return {
		id: crypto.randomUUID(),
		source_site_id: null,
		target_site_id: targetSiteId,
		kind,
		ref_id: refId ?? null,
		idempotency_key: idempotencyKey ?? null,
		stream_id: streamId ?? null,
		payload,
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
	};
}
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: All existing agent tests pass (no regressions from signature change — `streamId` is optional)

**Commit:** `feat(agent): add optional streamId parameter to createRelayOutboxEntry`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 7-8) -->

<!-- START_TASK_7 -->
### Task 7: Define `ProcessPayload` and `StatusForwardPayload` in shared

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/shared/src/types.ts` (append after the existing `ErrorPayload` interface at line 297)

**Implementation:**

Append after the existing `ErrorPayload` interface:

```typescript
// Loop delegation payloads (Phase 7)
export interface ProcessPayload {
	thread_id: string;
	message_id: string;
	user_id: string;
	platform: string | null; // null = web UI delegation
}

export interface StatusForwardPayload {
	thread_id: string;
	status: string; // "idle" | "thinking" | "tool_call" | etc.
	detail: string | null; // e.g. tool name
	tokens: number;
}
```

These two interfaces use only primitive fields and belong in shared because they are consumed by both the agent package (emitter) and the web package (receiver/server).

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add ProcessPayload and StatusForwardPayload for loop delegation`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Define `InferenceRequestPayload`, `StreamChunkPayload`, `StreamEndPayload` in llm

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/llm/src/types.ts` (append after the existing `LLMError` class at line 78)

**Implementation:**

Append after `LLMError`:

```typescript
// Inference relay payload types
export interface InferenceRequestPayload {
	model: string;
	messages: LLMMessage[];
	tools?: ToolDefinition[];
	system?: string;
	max_tokens?: number;
	temperature?: number;
	cache_breakpoints?: number[];
	timeout_ms: number;
}

export interface StreamChunkPayload {
	chunks: StreamChunk[];
	seq: number;
}

// stream_end has the same shape as stream_chunk — the relay kind field distinguishes them
export type StreamEndPayload = StreamChunkPayload;
```

These types reference `LLMMessage`, `ToolDefinition`, and `StreamChunk` which are defined in the same file, making `packages/llm` the correct home for them. They cannot live in `packages/shared` (which has zero runtime deps and no visibility of LLM types).

**Verification:**

Run: `tsc -p packages/llm --noEmit`
Expected: No type errors

Run: `bun test packages/llm`
Expected: All existing LLM driver tests pass

**Commit:** `feat(llm): add InferenceRequestPayload, StreamChunkPayload, StreamEndPayload types`
<!-- END_TASK_8 -->

<!-- START_TASK_9 -->
### Task 9: Propagate `stream_id` through the sync relay transport

**Verifies:** None (critical infrastructure — without this, `readInboxByStreamId()` will always return empty results)

**Files:**
- Modify: `packages/shared/src/types.ts` (RelayMessage interface at lines 251–261)
- Modify: `packages/sync/src/routes.ts` (hub relay route — inline RelayInboxEntry construction at lines 145–155 and writeOutbox call at 156–166; pending-for-requester mapping at lines 179–191)
- Modify: `packages/shared/src/types.ts` (add `"status:forward"` event to TypedEventEmitter event map)

**Why this matters:** After Phase 1 adds `stream_id` to the `RelayOutboxEntry` and `RelayInboxEntry` interfaces, the hub relay route in `packages/sync/src/routes.ts` must also propagate `stream_id` when it:
1. Re-packages a requester's outbox entry as an inbox entry for the target spoke
2. Re-packages a pending outbox entry (for the requester) as an inbox entry to return

Without this, all `stream_id` values are `null` after hub routing, so `readInboxByStreamId()` on the requester never finds its chunks.

**Implementation:**

**Part A: Add `stream_id` to `RelayMessage` interface in `packages/shared/src/types.ts`** (lines 251–261):

```typescript
export interface RelayMessage {
	id: string;
	target_site_id: string;
	source_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	stream_id: string | null;  // <-- add this
	payload: string;
	created_at: string;
	expires_at: string;
}
```

**Part B: Add `"status:forward"` event to the TypedEventEmitter event map** (same file, wherever the event map is defined — search for `"sync:trigger"` or `"agent:cancel"` to find the map). Add:

```typescript
"status:forward": (payload: StatusForwardPayload) => void;
```

This makes the type assertion `as any` in Phase 7 Task 3 unnecessary and provides compile-time safety for status forwarding.

**Part C: Fix hub relay route in `packages/sync/src/routes.ts`**

At lines 145–155 (inline `RelayInboxEntry` construction), add `stream_id: entry.stream_id ?? null`:

```typescript
const inboxEntry: RelayInboxEntry = {
    id: crypto.randomUUID(),
    source_site_id: requesterSiteId,
    kind: entry.kind,
    ref_id: entry.ref_id ?? entry.id,
    idempotency_key: entry.idempotency_key,
    stream_id: entry.stream_id ?? null,   // propagate stream_id from request
    payload: entry.payload,
    expires_at: entry.expires_at,
    received_at: new Date().toISOString(),
    processed: 0,
};
```

At lines 156–166 (`writeOutbox` call), add `stream_id: entry.stream_id ?? null`:

```typescript
writeOutbox(db, {
    id: inboxEntry.id,
    source_site_id: requesterSiteId,
    target_site_id: entry.target_site_id,
    kind: entry.kind,
    ref_id: entry.ref_id ?? entry.id,
    idempotency_key: entry.idempotency_key,
    stream_id: entry.stream_id ?? null,    // propagate stream_id
    payload: entry.payload,
    created_at: new Date().toISOString(),
    expires_at: entry.expires_at,
});
```

At lines 179–191 (pending-for-requester mapping), add `stream_id: pending.stream_id ?? null`:

```typescript
inboxForRequester.push({
    id: pending.id,
    source_site_id: pending.source_site_id ?? requesterSiteId,
    kind: pending.kind,
    ref_id: pending.ref_id,
    idempotency_key: pending.idempotency_key,
    stream_id: pending.stream_id ?? null,  // propagate stream_id to requester
    payload: pending.payload,
    expires_at: pending.expires_at,
    received_at: new Date().toISOString(),
    processed: 0,
});
```

The eager push path (lines ~218–242) passes `RelayInboxEntry` objects directly — once the inline construction above is fixed, eager push will carry `stream_id` correctly.

**Testing:**

Add a unit test in `packages/sync/src/__tests__/relay.integration.test.ts` (or a new test file):
- Write an outbox entry on spoke A with a non-null `stream_id`
- Run a sync cycle (spoke A → hub → spoke B)
- Query spoke B's `relay_inbox`: verify the entry has the same `stream_id`

**Verification:**

Run: `tsc -p packages/shared --noEmit && tsc -p packages/sync --noEmit`
Expected: No type errors (the TypeScript compiler will enforce `stream_id` is present on all constructions)

Run: `bun test packages/sync`
Expected: All sync tests pass including the new stream_id round-trip test

**Commit:** `feat(sync): propagate stream_id through hub relay route for streaming inference`
<!-- END_TASK_9 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase Completion Verification

After all 9 tasks are committed:

Run all relay-related tests:
```bash
bun test packages/core/src/__tests__/relay.test.ts
bun test packages/agent/src/__tests__/relay-wait.test.ts
```
Expected: All tests pass with no regressions.

Run typechecks for all affected packages (in dependency order):
```bash
tsc -p packages/shared --noEmit
tsc -p packages/llm    --noEmit
tsc -p packages/core   --noEmit
tsc -p packages/agent  --noEmit
```
Expected: Zero type errors across all packages.

Run full test suite for affected packages:
```bash
bun test packages/shared
bun test packages/llm
bun test packages/core
bun test packages/agent
bun test packages/sync
```
Expected: All tests pass. No new failures introduced.
