# Platform-Scoped Tools Implementation Plan — Phase 1

**Goal:** Add new optional fields and methods to shared interfaces across packages so TypeScript builds cleanly with zero behavior changes.

**Architecture:** Pure interface additions. No runtime behavior changes. All new fields are optional, so existing call sites compile unchanged. The `platformTools` map type is defined inline in `AgentLoopConfig` to avoid a cross-package import from agent → platforms.

**Tech Stack:** TypeScript 6.x, `@bound/shared`, `@bound/agent`, `@bound/platforms`, `@bound/llm`

**Scope:** Phase 1 of 4 from the original design

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

This phase sets up the structural foundation. The ACs it directly enables (structural contracts) are verified by typecheck passing. Behavioral verification happens in Phases 2–4.

### platform-scoped-tools.AC2: `PlatformConnector.getPlatformTools()` interface
- **platform-scoped-tools.AC2.1 Success:** `DiscordConnector.getPlatformTools(threadId)` returns a map containing key `"discord_send_message"` with a valid `toolDefinition` (correct name, description, and parameters schema)
- **platform-scoped-tools.AC2.2 Success:** The `execute` closure in the returned map is bound to the given `threadId`

---

## Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-5) -->

<!-- START_TASK_1 -->
### Task 1: Narrow `PlatformConnector.deliver()` and add `getPlatformTools()`

**Verifies:** None (infrastructure — TypeScript compiler verifies structural correctness)

**Files:**
- Modify: `packages/platforms/src/connector.ts:44-49`

**Implementation:**

Replace the `deliver()` signature attachment parameter and add the new optional method at the end of the interface.

Change `attachments?: unknown[]` to `attachments?: Array<{ filename: string; data: Buffer }>` in `deliver()`.

Add the following optional method after `handleWebhookPayload?`:

```typescript
/**
 * Contribute platform-specific tool definitions to the agent loop.
 *
 * @param threadId - The thread ID the agent loop is processing. Closures returned
 *   in the map must capture this value so execution is bound to the correct thread.
 * @returns A map from tool name to tool definition + execute closure. The execute
 *   closure receives the LLM's input object and returns a result string.
 */
getPlatformTools?(threadId: string): Map<string, {
  toolDefinition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}>;
```

You will need to import `ToolDefinition` from `@bound/llm` at the top of the file:
```typescript
import type { ToolDefinition } from "@bound/llm";
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No new type errors (may see errors from implementations — addressed in Task 2)

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update `PlatformDeliverPayload` in shared and fix all connector implementations

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/shared/src/types.ts` — line 344 (`PlatformDeliverPayload.attachments`)
- Modify: `packages/platforms/src/connectors/webhook-stub.ts` — line 27 (`_attachments` parameter)
- Modify: `packages/platforms/src/__tests__/registry.test.ts` — `_MockConnector.deliver()` signature (line ~42-49)

**Context:** `PlatformDeliverPayload` in `@bound/shared` carries `attachments?: unknown[]`. The registry routes this payload to `connector.deliver()`. After narrowing `deliver()` in Task 1, TypeScript will error on this call site (`registry.ts:52`) unless `PlatformDeliverPayload.attachments` is narrowed to match.

**Implementation:**

In `packages/shared/src/types.ts`, find `PlatformDeliverPayload` (around line 339) and narrow:
```typescript
// Before:
attachments?: unknown[];
// After:
attachments?: Array<{ filename: string; data: Buffer }>;
```

In `packages/platforms/src/connectors/webhook-stub.ts`, update `deliver()` parameter:
```typescript
// Before:
_attachments?: unknown[],
// After:
_attachments?: Array<{ filename: string; data: Buffer }>,
```

In `packages/platforms/src/__tests__/registry.test.ts`, update `_MockConnector.deliver()`:
```typescript
// Before:
async deliver(
  threadId: string,
  messageId: string,
  content: string,
  attachments?: unknown[],
): Promise<void>
// After:
async deliver(
  threadId: string,
  messageId: string,
  content: string,
  attachments?: Array<{ filename: string; data: Buffer }>,
): Promise<void>
```

Also update the `deliverCalls` type on `_MockConnector`:
```typescript
// Before:
deliverCalls: Array<{
  threadId: string;
  messageId: string;
  content: string;
  attachments?: unknown[];
}> = [];
// After:
deliverCalls: Array<{
  threadId: string;
  messageId: string;
  content: string;
  attachments?: Array<{ filename: string; data: Buffer }>;
}> = [];
```

**Verification:**
Run: `tsc -p packages/shared --noEmit && tsc -p packages/platforms --noEmit`
Expected: No new type errors related to deliver/attachments

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add `platform` and `platformTools` to `AgentLoopConfig`

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/types.ts:17-31`

**Implementation:**

Add two new optional fields to `AgentLoopConfig`. The `platformTools` map type is defined inline to avoid introducing a new cross-package dependency from `agent` → `platforms`. The `ToolDefinition` type is already available from `@bound/llm` which `agent` already imports.

Add an import for `ToolDefinition` at the top of the file:
```typescript
import type { ToolDefinition } from "@bound/llm";
```

Then add the two fields to `AgentLoopConfig`:
```typescript
export interface AgentLoopConfig {
  threadId: string;
  taskId?: string;
  userId: string;
  modelId?: string;
  abortSignal?: AbortSignal;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  /** Platform identifier when the loop runs in a platform context (e.g. "discord"). */
  platform?: string;
  /**
   * Platform-contributed tool closures, keyed by tool name.
   * The agent loop checks this map before falling through to sandbox dispatch.
   */
  platformTools?: Map<string, {
    toolDefinition: ToolDefinition;
    execute: (input: Record<string, unknown>) => Promise<string>;
  }>;
}
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No new errors from types.ts

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add `platformContext` to `ContextParams`

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:9-26`

**Implementation:**

Add `platformContext?` to `ContextParams`, following the same optional-field pattern as `relayInfo`:

```typescript
export interface ContextParams {
  db: Database;
  threadId: string;
  taskId?: string;
  userId: string;
  currentModel?: string;
  contextWindow?: number;
  noHistory?: boolean;
  configDir?: string;
  hostName?: string;
  siteId?: string;
  relayInfo?: {
    remoteHost: string;
    localHost: string;
    model: string;
    provider: string;
  };
  /** When set, assembleContext() prepends a system message explaining silence semantics. */
  platformContext?: { platform: string };
}
```

Do NOT add any logic yet — that is Phase 3's task. This task only extends the interface.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Verify full typecheck passes and commit

**Verifies:** None (infrastructure)

**Files:** No changes — verification only

**Step 1: Run full typecheck across all packages**

```bash
bun run typecheck
```

Expected: All packages pass with no new errors. If any errors appear, fix them before committing.

**Step 2: Commit**

```bash
git add packages/platforms/src/connector.ts \
        packages/shared/src/types.ts \
        packages/platforms/src/connectors/webhook-stub.ts \
        packages/platforms/src/__tests__/registry.test.ts \
        packages/agent/src/types.ts \
        packages/agent/src/context-assembly.ts
git commit -m "feat(platforms,agent): add platform-scoped tools interface contracts"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_A -->
