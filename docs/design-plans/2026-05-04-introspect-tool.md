# Introspect Tool Design

## Summary

The introspect tool enables synchronous question-answering between agent threads within the same Bound deployment. When one thread needs deeper reflection or context-specific insight, it can use the `introspect` tool to send a question to another thread, pause execution, wait for that thread to formulate a response, and then continue with the answer. This provides a lightweight mechanism for agents to consult specialized threads without reimplementing agent logic or manually coordinating through the database.

The implementation reuses four proven patterns from the existing codebase: notification dispatch/wakeup (from the `notify` tool), blocking poll-wait (from `await_event`), post-turn hooks (from delivery-check), and metadata-based correlation (from the messages table's `metadata` property bag). The caller enqueues a notification with a correlation UUID, polls the messages table for a response stamped with that correlation ID, and returns the assistant message content once detected. The target thread processes the introspect request as a natural developer-role message and responds normally. A post-loop hook stamps the target's response with the correlation ID so the caller can detect it. Cross-host operation is supported via relay forwarding (request leg) and changelog sync (response leg).

## Definition of Done

A new `introspect` builtin agent tool that performs synchronous round-trip questioning between threads:

- Sends a request to a target thread, wakes it, blocks the calling thread, and returns the target's final assistant response once its turn completes (end_turn / stop)
- Thread-only targeting (no user mode) — designed for internal agent-to-agent questioning
- Follows existing patterns: notify's dispatch/wakeup (including relay forwarding for cross-host), await_event's polling-within-execute
- The target sees the introspect request as a developer-role notification and responds naturally — no special response tool needed on the target side
- Cross-host support via relay (request leg) + changelog sync (response leg)
- Timeout handling with configurable timeout (default 5 minutes)

## Acceptance Criteria

### introspect-tool.AC1: Input Validation & Guards
- **introspect-tool.AC1.1 Success:** Valid `thread_id` and `message` accepted, notification enqueued to target
- **introspect-tool.AC1.2 Failure:** Missing or empty `thread_id` returns error without enqueuing
- **introspect-tool.AC1.3 Failure:** Self-introspect (target = current thread) returns error without enqueuing
- **introspect-tool.AC1.4 Failure:** Target thread not found or deleted returns error without enqueuing

### introspect-tool.AC2: Request Dispatch & Wakeup
- **introspect-tool.AC2.1 Success:** Notification enqueued with `{ type: "introspect", correlation_id, source_thread, content }` payload and `introspect_id` written to injected message metadata
- **introspect-tool.AC2.2 Success:** Target thread wakes, processes request as developer-role message, produces assistant response, and response is stamped with `introspect_response_id` in metadata
- **introspect-tool.AC2.3 Success:** Caller detects stamped response and returns assistant message content

### introspect-tool.AC3: Timeout & Error Handling
- **introspect-tool.AC3.1 Failure:** Caller returns timeout error when no response within configured timeout
- **introspect-tool.AC3.2 Failure:** Caller detects target turn with `status = 'error'` and returns early with error message
- **introspect-tool.AC3.3 Failure:** Caller detects target turn with `status = 'aborted'` and returns early with error message

### introspect-tool.AC4: Post-Loop Hook Behavior
- **introspect-tool.AC4.1 Success:** Hook is no-op when turn was not triggered by introspect notification
- **introspect-tool.AC4.2 Success:** Hook handles multiple `introspect_id` messages in one turn, stamping each independently
- **introspect-tool.AC4.3 Edge:** Hook does not stamp when target turn produces no assistant message (error before output)

### introspect-tool.AC5: Cross-Host
- **introspect-tool.AC5.1 Success:** Request reaches remote host via relay forwarding (same path as notify)
- **introspect-tool.AC5.2 Success:** Response metadata syncs back to calling host via changelog, caller detects it

## Glossary

- **agent loop**: The state machine (`IDLE → HYDRATE_FS → ASSEMBLE_CONTEXT → LLM_CALL → ...`) that processes a thread's messages, calls the LLM, executes tools, and persists results. Runs per-thread on the host where the thread is active.
- **builtin agent tool**: One of the 14 native agent tools (schedule, query, memory, etc.) with structured JSON schemas. The introspect tool will become the 15th. Distinct from MCP tools (external) and client tools (deferred to WS client).
- **changelog sync**: The mechanism by which writes to synced tables propagate across hosts. Every write generates a `change_log` entry via the outbox pattern, transmitted over the sync WebSocket and replayed on remote hosts.
- **ContentBlock**: Discriminated union type representing a single unit of LLM message content (text | tool_use | image | document). Messages can have `content: string | ContentBlock[]`.
- **correlation ID**: A UUID generated by the caller that links the introspect request (`introspect_id` in request message metadata) with the target's response (`introspect_response_id` in assistant message metadata).
- **developer-role message**: A special message role used for system-generated context intended for the agent (notifications, wakeup context). Distinct from `system` role (stable-prefix prompt) and `user`/`assistant` (conversational turns).
- **dispatch_queue**: Local-only SQLite table storing pending work items for threads. Items are claimed atomically via `status='pending'` CAS pattern.
- **event bus**: In-memory pub/sub system used to trigger immediate actions (e.g., `notify:enqueued` wakes the target thread). Events do not persist across restarts.
- **metadata property bag**: Opaque JSON field on the `messages` table. Read via `readMessageMetadata()`, written via `writeMessageMetadata()` with additive merge. Namespaced by convention (`discord_*`, `introspect_*`). Syncs via changelog.
- **post-loop hook**: A function called after the agent loop completes a full drain. `delivery-check` is the existing example; introspect response stamp will be the second. Receives `{ db, siteId, threadId, turnStartAt }`.
- **relay**: The inference routing system that allows a spoke to forward LLM requests to a remote hub. Requests go via `relay_outbox`, responses via `relay_inbox`.
- **synced table**: A table where all writes use the outbox pattern to generate changelog entries that propagate to other hosts. `messages` and `turns` are synced; `dispatch_queue` is not.
- **ThreadExecutor**: Per-thread exclusive lock ensuring only one agent loop runs per thread at a time. Requests queue and process serially.
- **turn**: A single cycle of the agent loop from notification/input through LLM call(s) and tool execution(s) to final assistant response. Recorded in the `turns` table with `status` (ok/error/aborted).

## Architecture

The introspect tool has two cooperating halves: a caller-side blocking executor and a target-side post-loop response stamp.

**Caller side** (within `execute()`, blocks until response):

1. Validate target thread exists and isn't current thread
2. Generate `correlationId` (UUID)
3. Enqueue notification to target with payload `{ type: "introspect", correlation_id, source_thread, content }`
4. Write `{ introspect_id: correlationId }` into the injected developer-role message's metadata at injection time
5. Emit `"notify:enqueued"` event to wake target thread
6. Enter polling loop (2s intervals, configurable timeout): query `messages` table for a row where metadata contains matching `introspect_response_id`
7. On match: return assistant message content as-is (`string | ContentBlock[]`)
8. On timeout/error: return error string

**Target side** (post-loop hook, runs after turn completes):

1. Query developer-role messages in turn window for `introspect_id` in metadata
2. If none found: return early (no-op for non-introspect turns)
3. If found: locate last assistant-role message in same turn window
4. Stamp assistant message with `{ introspect_response_id: correlationId }` via `writeMessageMetadata()`

**Cross-host flow:** Request reaches remote host via relay forwarding (same path as notify). Response is detectable on calling host because `messages.metadata` syncs back via changelog. Polling naturally accommodates the few-second sync propagation delay.

**Contracts:**

Tool schema:
```typescript
const introspectSchema = z.object({
  thread_id: z.string().describe("Target thread ID to introspect"),
  message: z.string().describe("Question or request to send to the target thread"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default 300000)"),
});
```

Notification payload:
```typescript
interface IntrospectPayload {
  type: "introspect";
  correlation_id: string;
  source_thread: string | null;
  content: string;
}
```

Post-loop hook:
```typescript
export async function runIntrospectResponseStamp(params: {
  db: Database;
  siteId: string;
  threadId: string;
  turnStartAt: string;
}): Promise<void>
```

ToolDefinition:
- Name: `introspect`
- Kind: `"builtin"`
- Description: "Introspect on a question by consulting another one of your threads. Use when you need deeper reflection or insight informed by a different context."

## Existing Patterns

This design follows four established patterns from the codebase:

**notify tool** (`packages/agent/src/tools/notify.ts`): Dispatch/wakeup mechanism, notification payload structure (`{ type, source_thread, content }`), `enqueueNotification()` + event bus emission, `formatNotification()` for human-readable injection.

**await_event tool** (`packages/agent/src/tools/await-event.ts`): Polling within `execute()` at 2-second intervals, 5-minute default timeout, synchronous blocking without special agent loop states.

**delivery-check** (`packages/core/src/delivery-check.ts`): Post-loop hook pattern — self-contained function receiving `{ db, siteId, threadId, turnStartAt }`, registered as a single call in server.ts alongside the main dispatch loop.

**messages.metadata** (`packages/core/src/change-log.ts`): `readMessageMetadata()` / `writeMessageMetadata()` for opaque property bags on messages. Additive merge, goes through `updateRow()` for changelog sync. Namespace convention: `introspect_*` keys (following Discord's `discord_*` pattern).

No divergence from existing patterns. The tool is a composition of these four proven mechanisms.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Core Tool Skeleton
**Goal:** Introspect tool registered, validates inputs, enqueues notification to target thread with correlation metadata

**Components:**
- `packages/agent/src/tools/introspect.ts` — tool factory with schema, validation, notification enqueue, metadata write on injected message
- `packages/agent/src/tools/index.ts` — register `createIntrospectTool` in `createAgentTools()` array
- `packages/core/src/dispatch.ts` — add `"introspect"` case to `formatNotification()` for human-readable injection text

**Dependencies:** None

**Done when:** Tool is registered, calling it enqueues a notification with correlation ID to the target thread, the injected developer-role message has `introspect_id` in metadata, target thread wakes and responds naturally. Tests verify: validation rejects missing thread_id, self-introspect guard, correct payload structure, metadata written on injection.

**Covers:** introspect-tool.AC1.1, AC1.2, AC1.3, AC2.1
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Polling Loop & Response Detection
**Goal:** Caller blocks and detects target's response via metadata correlation

**Components:**
- `packages/agent/src/tools/introspect.ts` — polling loop after enqueue: queries messages for `introspect_response_id` match, timeout handling, early termination on target turn error/abort

**Dependencies:** Phase 1

**Done when:** Caller polls and returns target's assistant message content when response stamp appears. Timeout returns error. Target turn error/abort detected and surfaced early. Tests verify: successful round-trip, timeout behavior, error turn detection.

**Covers:** introspect-tool.AC2.2, AC2.3, AC3.1, AC3.2, AC3.3
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Post-Loop Response Stamp Hook
**Goal:** Target thread's response is tagged with correlation metadata after turn completion

**Components:**
- `packages/agent/src/tools/introspect.ts` — `runIntrospectResponseStamp()` exported function
- `packages/cli/src/commands/start/server.ts` — register hook call after delivery-check

**Dependencies:** Phase 1

**Done when:** Post-loop hook stamps last assistant message with `introspect_response_id` when turn was triggered by introspect notification. No-op on non-introspect turns. Handles multiple introspect requests per turn. Tests verify: stamp applied correctly, no-op on normal turns, multiple correlation IDs handled independently.

**Covers:** introspect-tool.AC2.2, AC4.1, AC4.2
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Cross-Host & Integration Testing
**Goal:** Verify end-to-end flow including relay forwarding and changelog sync

**Components:**
- `packages/agent/src/tools/__tests__/introspect.test.ts` — unit tests for tool logic
- `packages/agent/src/tools/__tests__/introspect.integration.test.ts` — integration test with real DB, mock LLM, verifying full round-trip including post-loop hook

**Dependencies:** Phases 2, 3

**Done when:** Integration test demonstrates full flow: enqueue → target wakes → target responds → hook stamps → caller detects → returns content. Cross-host path verified by confirming metadata syncs via changelog (turns and messages are synced tables).

**Covers:** introspect-tool.AC5.1, AC5.2, AC4.3
<!-- END_PHASE_4 -->

## Additional Considerations

**Concurrent introspect requests:** If a target thread receives multiple introspect notifications before processing, they queue in dispatch_queue and process serially (ThreadExecutor exclusive lock). The post-loop hook iterates all `introspect_id` messages in the turn window, stamping each independently. Callers with different correlation IDs only see their own response.

**Target multi-turn execution:** If the target uses tools during its turn (multiple LLM calls), the post-loop hook fires only after the full drain loop completes. The stamped message is the final assistant message — after all tool execution finishes.

**Response size:** No explicit truncation. The caller receives the full assistant message content. If size becomes problematic in practice, a cap can be added later (await_event uses 50KB but that's for aggregated task results, not single messages).
