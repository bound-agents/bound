# Introspect Tool Implementation Plan — Phase 1: Core Tool Skeleton

**Goal:** Register the introspect tool with input validation, notification dispatch to the target thread, and correlation metadata written on the injected message.

**Architecture:** Factory-function tool following the notify.ts pattern — Zod schema validation, `enqueueNotification()` for dispatch, event bus emission for wakeup, `writeMessageMetadata()` for correlation tagging.

**Tech Stack:** TypeScript, Zod v4, bun:sqlite, bun:test

**Scope:** 4 phases from original design (phase 1 of 4)

**Codebase verified:** 2026-05-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### introspect-tool.AC1: Input Validation & Guards
- **introspect-tool.AC1.1 Success:** Valid `thread_id` and `message` accepted, notification enqueued to target
- **introspect-tool.AC1.2 Failure:** Missing or empty `thread_id` returns error without enqueuing
- **introspect-tool.AC1.3 Failure:** Self-introspect (target = current thread) returns error without enqueuing
- **introspect-tool.AC1.4 Failure:** Target thread not found or deleted returns error without enqueuing

### introspect-tool.AC2: Request Dispatch & Wakeup
- **introspect-tool.AC2.1 Success:** Notification enqueued with `{ type: "introspect", correlation_id, source_thread, content }` payload and `introspect_id` written to injected message metadata

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->
<!-- START_TASK_1 -->
### Task 1: Create introspect tool factory with schema and validation

**Verifies:** introspect-tool.AC1.1, introspect-tool.AC1.2, introspect-tool.AC1.3, introspect-tool.AC1.4, introspect-tool.AC2.1

**Files:**
- Create: `packages/agent/src/tools/introspect.ts`

**Implementation:**

Create the tool factory following the exact pattern from `packages/agent/src/tools/notify.ts`. The tool:

1. Defines a Zod schema:
   ```typescript
   const introspectSchema = z.object({
     thread_id: z.string().describe("Target thread ID to introspect"),
     message: z.string().describe("Question or request to send to the target thread"),
     timeout: z.number().optional().describe("Timeout in milliseconds (default 300000)"),
   });
   ```

2. Uses `zodToToolParams()` and `parseToolInput()` from `./tool-schema.ts`

3. Validates:
   - Input parsing via `parseToolInput(introspectSchema, raw, "introspect")` — handles AC1.2 (missing/empty thread_id returns error)
   - Self-introspect guard: `if (input.thread_id === ctx.threadId)` returns error string — handles AC1.3
   - Thread existence: `SELECT id FROM threads WHERE id = ? AND deleted = 0` — handles AC1.4 (Phase 1 does not test AC1.4 per design but implements the check)

4. Dispatches notification:
   - Generates `correlationId = randomUUID()`
   - Calls `enqueueNotification(ctx.db, input.thread_id, { type: "introspect", correlation_id: correlationId, source_thread: ctx.threadId ?? null, content: input.message })`
   - Emits `ctx.eventBus.emit("notify:enqueued", { thread_id: input.thread_id })`

5. Returns the `correlationId` in the success message (the polling loop in Phase 2 will use it)

The `execute` function returns a string result. In Phase 1, success returns a message like `"Introspect request sent to thread ${input.thread_id} with correlation ${correlationId}. Awaiting response..."`. In Phase 2, this will be replaced by the polling loop.

**Key imports:**
- `import { z } from "zod"` 
- `import { randomUUID } from "crypto"`
- `import { enqueueNotification } from "@bound/core"`
- `import { zodToToolParams, parseToolInput } from "./tool-schema"`
- `import type { ToolContext, RegisteredTool } from "../types"`

**Export:** `export function createIntrospectTool(ctx: ToolContext): RegisteredTool`

**ToolDefinition:**
- Name: `"introspect"`
- Kind: `"builtin"`
- Description: `"Introspect on a question by consulting another one of your threads. Use when you need deeper reflection or insight informed by a different context."`

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/introspect.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): add introspect tool skeleton with validation and dispatch`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Register introspect tool in createAgentTools

**Files:**
- Modify: `packages/agent/src/tools/index.ts`

**Implementation:**

Add `createIntrospectTool` to the `createAgentTools()` array. Follow the existing pattern:

1. Add import: `import { createIntrospectTool } from "./introspect";`
2. Add `createIntrospectTool(ctx)` to the returned array in `createAgentTools()`

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Run: `bun test packages/agent`
Expected: All existing tests still pass (no regressions)

**Commit:** `feat(agent): register introspect tool in createAgentTools`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add "introspect" case to formatNotification

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` — add case in `formatNotification()`

**Implementation:**

Add a new case to the `formatNotification()` function's type switch. The function is in `packages/cli/src/commands/start/server.ts` and switches on `payload.type`. Add:

```typescript
case "introspect":
  return `[introspect request from thread ${payload.source_thread ?? "unknown"}] ${payload.content}`;
```

This follows the pattern of existing cases like `"proactive"` → `[notification from background task] ...`.

The content will be injected as a developer-role message into the target thread, which the agent processes naturally.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Run: `bun test packages/cli`
Expected: All existing tests still pass

**Commit:** `feat(cli): add introspect notification format case`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Unit tests for introspect tool validation and dispatch

**Verifies:** introspect-tool.AC1.1, introspect-tool.AC1.2, introspect-tool.AC1.3, introspect-tool.AC1.4, introspect-tool.AC2.1

**Files:**
- Create: `packages/agent/src/tools/__tests__/introspect.test.ts`

**Testing:**

Tests must verify each AC listed above. Follow the test patterns from `packages/agent/src/tools/__tests__/notify.test.ts`:

- Use in-memory database: `new Database(":memory:")` + `applySchema(db)`
- Create minimal ToolContext stub with event bus that captures emissions
- Insert test threads with `insertRow()` from `@bound/core`

Tests to write:

- **introspect-tool.AC1.1:** Valid `thread_id` and `message` accepted — call execute with valid inputs, verify result does NOT contain "Error", verify `enqueueNotification` wrote to dispatch_queue (`SELECT event_payload FROM dispatch_queue WHERE thread_id = ? AND event_type = 'notification' ORDER BY created_at DESC LIMIT 1`), verify event bus emitted `"notify:enqueued"`
- **introspect-tool.AC1.2:** Missing or empty `thread_id` — call execute with `{}` and with `{ thread_id: "", message: "hi" }`, verify result contains "Error" or validation failure message, verify NO dispatch_queue entry created
- **introspect-tool.AC1.3:** Self-introspect guard — set `ctx.threadId = "thread-1"` and call execute with `{ thread_id: "thread-1", message: "hi" }`, verify result contains error about self-introspect, verify NO dispatch_queue entry
- **introspect-tool.AC1.4:** Thread not found or deleted — call execute with `{ thread_id: "nonexistent-thread-id", message: "hi" }` where no such thread exists in the database, verify result contains error about thread not found or deleted, verify NO dispatch_queue entry created. Also test with a soft-deleted thread (insert thread with `deleted: 1`) and verify same error behavior.
- **introspect-tool.AC2.1:** Notification payload structure — call execute with valid inputs, query `dispatch_queue` for the entry (`SELECT event_payload FROM dispatch_queue WHERE thread_id = ? AND event_type = 'notification' ORDER BY created_at DESC LIMIT 1`), parse `event_payload` JSON and verify it contains `{ type: "introspect", correlation_id: <uuid>, source_thread: ctx.threadId, content: input.message }`

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/introspect.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add unit tests for introspect tool validation and dispatch`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->
