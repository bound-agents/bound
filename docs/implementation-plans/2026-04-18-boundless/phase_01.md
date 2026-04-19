# Boundless Implementation Plan — Phase 1: Package Scaffolding & Protocol Extensions

**Goal:** Create the `@bound/less` package skeleton and implement all three server-side protocol extensions with their client-side counterparts in `@bound/client`.

**Architecture:** A new workspace package `packages/less` is scaffolded with dependencies but no runtime code yet. Three backward-compatible additive changes are made to the existing WS protocol: `systemPromptAddition` on `session:configure`, `tool:cancel` server-to-client message, and `tool:result.content` widened to accept `ContentBlock[]`.

**Tech Stack:** TypeScript, Zod v4, bun:test, bun:sqlite

**Scope:** 8 phases from original design (phase 1 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC2: Protocol Extension — systemPromptAddition
- **boundless.AC2.1 Success:** `session:configure` with `systemPromptAddition` stores the string per (connection, threadId) pair for all subscribed threads
- **boundless.AC2.2 Success:** Agent loop's context assembly appends the stored string to the system suffix for the matching pair
- **boundless.AC2.3 Success:** `thread:subscribe` after `session:configure` inherits the connection's most recent systemPromptAddition
- **boundless.AC2.4 Success:** Re-sending `session:configure` replaces the stored string for all subscribed pairs; omitting the field clears it
- **boundless.AC2.5 Success:** `thread:unsubscribe` clears the pair's stored addition
- **boundless.AC2.6 Edge:** `session:configure` without `systemPromptAddition` field does not error; existing stored values cleared
- **boundless.AC2.7 Success:** Existing clients that do not send `systemPromptAddition` continue to work unchanged

### boundless.AC3: Protocol Extension — tool:cancel
- **boundless.AC3.1 Success:** `cancelThread(threadId)` emits `tool:cancel` with reason `thread_canceled` for every pending client_tool_call dispatch entry
- **boundless.AC3.2 Success:** TTL expiry emits `tool:cancel` with reason `dispatch_expired` and synthesizes tool-error LLMMessage for the agent loop
- **boundless.AC3.3 Success:** Connection close with pending entries emits `tool:cancel` with reason `session_reset` and synthesizes tool-error LLMMessage
- **boundless.AC3.4 Success:** Late `tool:result` for an already-canceled callId is accepted but discarded — no LLMMessage persisted
- **boundless.AC3.5 Success:** Client receiving `tool:cancel` for an unrecognized callId drops it silently
- **boundless.AC3.6 Edge:** Re-sending `session:configure` (MCP hot-reload) does NOT trigger tool:cancel for pending entries — they are preserved and re-delivered

### boundless.AC10: Protocol Extension — Content Widening
- **boundless.AC10.1 Success:** `tool:result` with `content: string` persisted as single text block (backward compatible)
- **boundless.AC10.2 Success:** `tool:result` with `content: ContentBlock[]` (text, image, document) persisted verbatim
- **boundless.AC10.3 Failure:** `tool:result` with invalid ContentBlock variant (e.g., tool_use, thinking) rejected with error response
- **boundless.AC10.4 Success:** Existing string-only clients continue to work unchanged

---

## Infrastructure

<!-- START_TASK_1 -->
### Task 1: Scaffold `@bound/less` workspace package

**Files:**
- Create: `packages/less/package.json`
- Create: `packages/less/tsconfig.json`
- Create: `packages/less/src/index.ts` (empty placeholder)

**Step 1: Create package.json**

```json
{
	"name": "@bound/less",
	"version": "0.0.1",
	"description": "Terminal-based coding agent client for Bound",
	"type": "module",
	"main": "src/index.ts",
	"types": "src/index.ts",
	"dependencies": {
		"@bound/client": "workspace:*",
		"@bound/shared": "workspace:*",
		"@bound/llm": "workspace:*",
		"@modelcontextprotocol/sdk": "^1.12.1",
		"ink": "^5.2.0",
		"react": "^18.3.1",
		"react-dom": "^18.3.1",
		"zod": "^4.0.0"
	},
	"devDependencies": {
		"@types/react": "^18.3.18"
	}
}
```

Verify the `@modelcontextprotocol/sdk` version matches what `packages/agent/package.json` uses. Adjust the version in the file above if different.

Note: `@bound/llm` is added as a dependency for the `ContentBlock` type. The design's dependency graph shows only `@bound/client` and `@bound/shared`, but `ContentBlock` is defined in `@bound/llm` and not re-exported from `@bound/shared`. This is a pragmatic deviation — `@bound/llm` is a types-only dependency here (no runtime code from llm is used).

**Step 2: Create tsconfig.json**

Extend the root `tsconfig.json` via `"extends": "../../tsconfig.json"`. Override with these settings specific to `@bound/less`: `"jsx": "react-jsx"` (required for .tsx files — no other package in this monorepo uses JSX), `"composite": true`, `"outDir": "dist"`, `"rootDir": "src"`. Include `["src"]`, exclude `["src/**/*.test.ts", "src/**/*.test.tsx"]`.

**Step 3: Create placeholder src/index.ts**

```ts
// @bound/less — boundless terminal client
// Placeholder for package scaffolding
```

**Step 4: Add to root tsconfig.json references**

Add `{ "path": "packages/less" }` to the `references` array in the root `tsconfig.json` (after the existing `packages/platforms` entry).

**Step 5: Verify operationally**

Run: `bun install`
Expected: Installs without errors, workspace link resolves @bound/less

Run: `tsc -p packages/less --noEmit`
Expected: Typechecks without errors

**Step 6: Commit**

```bash
git add packages/less/
git commit -m "chore: scaffold @bound/less workspace package"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add `boundless` binary target to build script

**Files:**
- Modify: `scripts/build.ts:49-70` (add Step 5 + update summary)

**Step 1: Add compilation step**

After the Step 4 (bound-mcp) block in `scripts/build.ts`, add a Step 5 block that compiles `packages/less/src/boundless.tsx` to `dist/boundless` using the same `bun build --compile` pattern. The entrypoint file does not exist yet (it will be created in Phase 8), so the compilation will fail gracefully — that's expected and matches the existing pattern of non-fatal compilation errors.

Also update the summary `for...of` loop (line 63) to include `"dist/boundless"` in the array.

**Step 2: Verify operationally**

Run: `bun run build`
Expected: boundless compilation fails (no entrypoint yet), but other 3 binaries succeed. The script should not exit with error code.

**Step 3: Commit**

```bash
git add scripts/build.ts
git commit -m "chore: add boundless binary target to build script"
```
<!-- END_TASK_2 -->

## Protocol Extension — systemPromptAddition

<!-- START_SUBCOMPONENT_A (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Server-side systemPromptAddition storage and propagation

**Verifies:** boundless.AC2.1, boundless.AC2.3, boundless.AC2.4, boundless.AC2.5, boundless.AC2.6, boundless.AC2.7

**Files:**
- Modify: `packages/web/src/server/websocket.ts:17-25` (sessionConfigureSchema)
- Modify: `packages/web/src/server/websocket.ts:66-81` (ClientConnection interface)
- Modify: `packages/web/src/server/websocket.ts:89-103` (ConnectionRegistry interface)
- Modify: `packages/web/src/server/websocket.ts:272-290` (handleSessionConfigure)
- Modify: `packages/web/src/server/websocket.ts:639-669` (registry implementation)
- Test: `packages/web/src/server/__tests__/websocket.test.ts`

**Implementation:**

1. Add `systemPromptAddition: z.string().optional()` to `sessionConfigureSchema` (after the `tools` field, line ~25).

2. Extend `ClientConnection` interface (line 66) with two new fields:
   - `systemPromptAddition: string | undefined` — connection-level value from the most recent `session:configure`
   - `systemPromptAdditions: Map<string, string>` — per-thread map keyed by threadId

3. Initialize both in the `open` handler where `ClientConnection` objects are created: `systemPromptAddition: undefined` and `systemPromptAdditions: new Map()`.

4. Extend `ConnectionRegistry` interface (line 89) with:
   ```ts
   getSystemPromptAdditionForThread(threadId: string): string | undefined;
   ```
   Implementation: iterate `clients`, find the first connection subscribed to `threadId` that has a `systemPromptAdditions` entry for it. Return the value or undefined.

5. Modify `handleSessionConfigure` (line 272) to:
   - Store `msg.systemPromptAddition` (may be undefined) in `conn.systemPromptAddition`
   - Iterate all `conn.subscriptions`: if `msg.systemPromptAddition` is defined, set `conn.systemPromptAdditions.set(threadId, msg.systemPromptAddition)` for each; if undefined, clear all entries via `conn.systemPromptAdditions.clear()`.

6. Modify the `thread:subscribe` handler to propagate: after adding the threadId to `conn.subscriptions`, if `conn.systemPromptAddition` is defined, also set `conn.systemPromptAdditions.set(threadId, conn.systemPromptAddition)`.

7. Modify the `thread:unsubscribe` handler to clean up: after removing from `conn.subscriptions`, also `conn.systemPromptAdditions.delete(threadId)`.

**Testing:**

Tests must verify each AC listed above using the existing MockWebSocket pattern in `packages/web/src/server/__tests__/websocket.test.ts`:
- boundless.AC2.1: Send session:configure with systemPromptAddition while subscribed to a thread, verify registry.getSystemPromptAdditionForThread returns the value
- boundless.AC2.3: Send session:configure with systemPromptAddition, then subscribe to a new thread, verify the new thread inherits the value
- boundless.AC2.4: Send session:configure twice with different values, verify replacement; send without field, verify cleared
- boundless.AC2.5: Subscribe, set systemPromptAddition, unsubscribe, verify cleared for that thread
- boundless.AC2.6: Send session:configure without systemPromptAddition field, verify no error and existing values cleared
- boundless.AC2.7: Send session:configure with tools only (no systemPromptAddition), verify tools work as before

**Verification:**
Run: `bun test packages/web/src/server/__tests__/websocket.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add systemPromptAddition to session:configure protocol`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Context assembly integration for systemPromptAddition

**Verifies:** boundless.AC2.2

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:17-47` (ContextParams interface)
- Modify: `packages/agent/src/context-assembly.ts:1020-1266` (suffixContent assembly)
- Test: `packages/agent/src/__tests__/context-assembly.test.ts`

**Implementation:**

1. Add `systemPromptAddition?: string` field to the `ContextParams` interface (line ~47, after `toolTokenEstimate`).

2. In the suffixContent assembly block (around line 1265, just before `suffixContent = suffixLines.join("\n")`), append the systemPromptAddition if present:
   ```ts
   if (params.systemPromptAddition) {
       suffixLines.push("");
       suffixLines.push(params.systemPromptAddition);
   }
   ```
   Place this AFTER all other volatile content so it appears at the end of the system suffix. This content is uncached and varying per-connection.

3. Also handle the `noHistory` path (autonomous tasks): if `params.systemPromptAddition` is set, append it to the standalone enrichment message as well. Look for the noHistory block near the beginning of the assembly and add the same append logic there.

**Testing:**

- boundless.AC2.2: Create a ContextParams with `systemPromptAddition: "You are a coding assistant..."`, run `assembleContext()`, verify the returned `systemSuffix` string contains the addition at the end. Also test that when `systemPromptAddition` is undefined, the suffix is unchanged from baseline.

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All tests pass (including existing tests unaffected)

**Commit:** `feat(agent): append systemPromptAddition to context assembly suffix`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Client-side systemPromptAddition support

**Verifies:** boundless.AC2.1 (client-side)

**Files:**
- Modify: `packages/client/src/client.ts:167-170` (configureTools method)
- Test: `packages/client/src/__tests__/client.test.ts`

**Implementation:**

1. Extend `configureTools` method signature from:
   ```ts
   configureTools(tools: ToolDefinition[]): void
   ```
   to:
   ```ts
   configureTools(tools: ToolDefinition[], options?: { systemPromptAddition?: string }): void
   ```

2. Store the options locally on the BoundClient instance for reconnection re-send (add a private field `private configureOptions?: { systemPromptAddition?: string }`).

3. Update the WS message sent to include `systemPromptAddition` if present (camelCase, matching the Zod schema):
   ```ts
   this.sendWsMessage({
       type: "session:configure",
       tools,
       ...(options?.systemPromptAddition !== undefined
           ? { systemPromptAddition: options.systemPromptAddition }
           : {}),
   });
   ```

4. In the reconnection handler (where `session:configure` is re-sent), include the stored options.

**Testing:**

- Verify that `configureTools(tools, { systemPromptAddition: "test" })` sends a WS message containing the field
- Verify that `configureTools(tools)` (no second arg) continues to work and does not include the field
- Verify reconnection re-sends the stored options

**Verification:**
Run: `bun test packages/client/src/__tests__/client.test.ts`
Expected: All tests pass

**Commit:** `feat(client): add systemPromptAddition option to configureTools`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_A -->

## Protocol Extension — tool:cancel

<!-- START_SUBCOMPONENT_B (tasks 6-8) -->

<!-- START_TASK_6 -->
### Task 6: Server-side tool:cancel emission helper

**Verifies:** boundless.AC3.1, boundless.AC3.2, boundless.AC3.3, boundless.AC3.6

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (add emitToolCancel helper)
- Modify: `packages/web/src/server/routes/status.ts:162-233` (cancelThread route)
- Test: `packages/web/src/server/__tests__/websocket.test.ts`

**Implementation:**

1. Add `emitToolCancel` helper inside `createWebSocketHandler`, after the existing handler functions. This function:
   - Takes `threadId: string` and `reason: "thread_canceled" | "dispatch_expired" | "session_reset"`
   - Queries `getPendingClientToolCalls(db, threadId)` to find pending entries
   - For each entry, parses `event_payload` to extract `callId` and `toolName`
   - Finds the connection that claimed the entry (via `claimed_by` field) or falls back to finding a subscribed connection
   - Sends `{ type: "tool:cancel", callId, threadId, reason }` via `conn.ws.send()`

2. Wire `emitToolCancel` into three call sites:

   **Site 1 — cancelThread (routes/status.ts:186):** After `cancelClientToolCalls(db, threadId)` is called, also call `emitToolCancel(threadId, "thread_canceled")` BEFORE the cancel happens (so we can still read pending entries). This requires reordering: emit first, then cancel.

   Actually, the approach needs to be: read pending entries BEFORE canceling, then cancel, then emit to connections. The `emitToolCancel` helper should accept the entries directly instead of re-querying.

   Revised approach:
   - `emitToolCancel(entries: DispatchEntry[], threadId: string, reason: string)`: takes pre-fetched entries
   - At cancelThread site: `const pending = getPendingClientToolCalls(db, threadId)` then `cancelClientToolCalls(db, threadId)` then `emitToolCancel(pending, threadId, "thread_canceled")`

   **Site 2 — TTL expiry:** The TTL expiry scan runs in `start.ts` via `setInterval`. `expireClientToolCalls(db, ttlMs, threadId?)` returns `DispatchEntry[]` (verified: `packages/core/src/dispatch.ts:229`). Pass the returned entries to `emitToolCancel`. This requires exposing `emitToolCancel` from the WS handler — add it to the returned object from `createWebSocketHandler`. For this site, reason is `"dispatch_expired"`. For each expired entry, synthesize a tool-error LLMMessage: insert a `tool_result` message via `insertRow(db, "messages", { role: "tool_result", content: "Error: Tool call expired (dispatch_expired)", tool_name: callId, ... }, siteId)` using the outbox pattern, then enqueue a `tool_result` dispatch entry via `enqueueToolResult(db, threadId, callId)` to wake the agent loop.

   **Site 3 — connection close:** In the `close` handler of `createWebSocketHandler`, find any pending client_tool_call entries where `claimed_by` matches the closing connection's `connectionId`. Emit `tool:cancel` with reason `"session_reset"`. For each cancelled entry, synthesize a tool-error LLMMessage using the outbox pattern: `insertRow(db, "messages", { role: "tool_result", content: "Error: Client tool call cancelled: client disconnected (session_reset)", tool_name: callId, thread_id: threadId, ... }, siteId)`, then `enqueueToolResult(db, threadId, callId)` to wake the agent loop. Note: the `tool:cancel` message is sent to the closing connection's WS (which may already be closed) — best-effort, ignore send errors.

3. Ensure `session:configure` (MCP hot-reload) does NOT trigger tool:cancel — verify that `handleSessionConfigure` does not touch pending dispatch entries. It currently only clears and re-populates `conn.clientTools`, which is correct.

**Testing:**

Tests must verify each AC listed above:
- boundless.AC3.1: Set up a pending client_tool_call, call cancelThread, verify `tool:cancel` message sent to client WS with reason `thread_canceled`
- boundless.AC3.2: Set up a pending client_tool_call past TTL, run expiry, verify `tool:cancel` with reason `dispatch_expired` and synthesized error message exists
- boundless.AC3.3: Set up a pending client_tool_call, close the connection, verify `tool:cancel` with reason `session_reset` and synthesized error message
- boundless.AC3.6: Set up pending entries, send session:configure, verify entries are NOT cancelled and no `tool:cancel` is sent

**Verification:**
Run: `bun test packages/web/src/server/__tests__/websocket.test.ts`
Expected: All tests pass

**Commit:** `feat(web): emit tool:cancel on thread cancel, TTL expiry, and connection close`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Late tool:result discard for canceled calls

**Verifies:** boundless.AC3.4

**Files:**
- Modify: `packages/web/src/server/websocket.ts:433-566` (handleToolResult)
- Test: `packages/web/src/server/__tests__/websocket.test.ts`

**Implementation:**

In `handleToolResult`, the existing logic already handles expired entries (line 450-478) by checking for entries with `status = 'expired'` and returning an error. However, the design says late `tool:result` for canceled calls should be "accepted but discarded" — not rejected with an error.

Modify the expired-entry check: instead of sending an error response to the client, silently accept the message (return without error, without persisting an LLMMessage). This satisfies "accepted but discarded." Optionally log at debug level for observability.

**Testing:**

- boundless.AC3.4: Cancel a client_tool_call (making its status 'expired'), then send a `tool:result` for that callId. Verify: no error sent to client, no new message persisted in messages table, handler returns cleanly.

**Verification:**
Run: `bun test packages/web/src/server/__tests__/websocket.test.ts`
Expected: All tests pass

**Commit:** `feat(web): silently discard late tool:result for canceled calls`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Client-side tool:cancel event handling

**Verifies:** boundless.AC3.5

**Files:**
- Modify: `packages/client/src/types.ts:191-207` (BoundClientEvents)
- Modify: `packages/client/src/client.ts` (WS message handler)
- Test: `packages/client/src/__tests__/client.test.ts`

**Implementation:**

1. Add `ToolCancelEvent` type to `packages/client/src/types.ts`:
   ```ts
   export interface ToolCancelEvent {
       callId: string;
       threadId: string;
       reason?: string;
   }
   ```

2. Add `"tool:cancel"` event to `BoundClientEvents`:
   ```ts
   "tool:cancel": (event: ToolCancelEvent) => void;
   ```

3. Widen `ToolCallResult.content` type from `string` to `string | ContentBlock[]` (types.ts:187). Import `ContentBlock` from `@bound/shared` or `@bound/llm` — check which package re-exports it. This prepares the type for Task 10's content widening.

4. In `client.ts`, find the WS message handler (the `onmessage` callback that dispatches by `data.type`). Add a case for `"tool:cancel"`:
   ```ts
   case "tool:cancel":
       this.emit("tool:cancel", {
           callId: data.call_id,
           threadId: data.thread_id,
           reason: data.reason,
       });
       break;
   ```
   If the client has no listener for `tool:cancel`, the event is simply dropped (satisfies AC3.5 — unrecognized callId is silently ignored by the client since no handler would match).

**Testing:**

- boundless.AC3.5: Receive a `tool:cancel` message for an unknown callId (no matching in-flight tool handler). Verify no error thrown, event emitted but silently dropped if no listener.
- Verify `tool:cancel` event is properly typed and emitted when a matching WS message arrives

**Verification:**
Run: `bun test packages/client/src/__tests__/client.test.ts`
Expected: All tests pass

**Commit:** `feat(client): add tool:cancel event and widen ToolCallResult.content type`
<!-- END_TASK_8 -->

<!-- END_SUBCOMPONENT_B -->

## Protocol Extension — Content Widening

<!-- START_SUBCOMPONENT_C (tasks 9-10) -->

<!-- START_TASK_9 -->
### Task 9: Server-side content widening for tool:result

**Verifies:** boundless.AC10.1, boundless.AC10.2, boundless.AC10.3, boundless.AC10.4

**Files:**
- Modify: `packages/web/src/server/websocket.ts:49-55` (toolResultSchema)
- Modify: `packages/web/src/server/websocket.ts:523-542` (handleToolResult content persistence)
- Test: `packages/web/src/server/__tests__/websocket.test.ts`

**Implementation:**

1. Define a `contentBlockSchema` Zod schema that validates the three allowed variants for tool results:
   ```ts
   const toolResultContentBlockSchema = z.discriminatedUnion("type", [
       z.object({ type: z.literal("text"), text: z.string() }),
       z.object({
           type: z.literal("image"),
           source: z.object({
               type: z.enum(["base64", "file_ref"]),
               media_type: z.string().optional(),
               data: z.string().optional(),
               file_id: z.string().optional(),
           }),
           description: z.string().optional(),
       }),
       z.object({
           type: z.literal("document"),
           source: z.object({
               type: z.enum(["base64", "file_ref"]),
               media_type: z.string().optional(),
               data: z.string().optional(),
               file_id: z.string().optional(),
           }),
           text_representation: z.string(),
           title: z.string().optional(),
       }),
   ]);
   ```
   Note: `tool_use` and `thinking` variants are intentionally excluded — they should be rejected (AC10.3).

2. Widen `toolResultSchema.content` from `z.string()` to:
   ```ts
   content: z.union([z.string(), z.array(toolResultContentBlockSchema)]),
   ```

3. Modify `handleToolResult` content persistence (line 525):
   - If `msg.content` is a string: persist as `JSON.stringify([{ type: "text", text: msg.content }])` — normalize to ContentBlock[] for storage (AC10.1)
   - If `msg.content` is an array: persist as `JSON.stringify(msg.content)` verbatim (AC10.2)
   - The `is_error` flag handling: when `is_error` is true and content is a string, wrap as before (`Error: ${msg.content}`). When `is_error` is true and content is a `ContentBlock[]`, persist the array as-is — the `is_error` flag is already stored separately in the dispatch logic, so the content blocks do not need modification.

4. The Zod validation on `toolResultSchema` will automatically reject `tool_use` and `thinking` variants since they're not in the discriminated union (AC10.3). The WS handler's parse error path will send an error response.

**Testing:**

Tests must verify each AC:
- boundless.AC10.1: Send `tool:result` with `content: "hello"` (string), verify persisted message content is `[{"type":"text","text":"hello"}]`
- boundless.AC10.2: Send `tool:result` with `content: [{"type":"text","text":"result"}, {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]`, verify persisted verbatim
- boundless.AC10.3: Send `tool:result` with `content: [{"type":"tool_use","id":"x","name":"y","input":{}}]`, verify rejected with error
- boundless.AC10.4: Existing test sending string content continues to pass unchanged

**Verification:**
Run: `bun test packages/web/src/server/__tests__/websocket.test.ts`
Expected: All tests pass

**Commit:** `feat(web): widen tool:result content to accept ContentBlock arrays`
<!-- END_TASK_9 -->

<!-- START_TASK_10 -->
### Task 10: Wire systemPromptAddition through agent loop factory

**Verifies:** boundless.AC2.2 (end-to-end wiring)

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (ConnectionRegistry.getSystemPromptAdditionForThread)
- Modify: `packages/cli/src/commands/start.ts` (agent loop factory)
- Test: `packages/web/src/server/__tests__/websocket.integration.test.ts`

**Implementation:**

1. The `ConnectionRegistry.getSystemPromptAdditionForThread()` method was added in Task 3. Verify it's accessible from the web server's route/handler layer.

2. In `packages/cli/src/commands/start.ts`, find the agent loop factory (the function that creates `AgentLoopConfig` for each thread invocation). This is where `ContextParams` are assembled before calling the agent loop. Add:
   ```ts
   const systemPromptAddition = wsRegistry?.getSystemPromptAdditionForThread(threadId);
   ```
   Pass `systemPromptAddition` into the `ContextParams` (or `AgentLoopConfig`) so it flows through to `assembleContext()`.

   Look for where the agent loop is invoked with thread context — likely in the `handleThread` function or similar. The `wsRegistry` (ConnectionRegistry) should be available in that scope from `createWebServer()`.

3. This wires the full flow: client sends `session:configure` with `systemPromptAddition` -> stored per (connection, thread) -> agent loop reads from registry -> passes to context assembly -> appended to system suffix.

**Testing:**

- Integration test: Set up a WS connection, send session:configure with systemPromptAddition, trigger an agent loop for that thread, verify the ContextParams received by assembleContext includes the systemPromptAddition string.

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): wire systemPromptAddition from ConnectionRegistry through agent loop`
<!-- END_TASK_10 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_11 -->
### Task 11: Verify existing test suite unaffected

**Files:**
- No modifications — verification only

**Step 1: Run full test suite**

Run: `bun test packages/core && bun test packages/agent && bun test packages/web && bun test packages/client`
Expected: All existing tests pass. No regressions from protocol changes.

Run: `tsc -p packages/web --noEmit && tsc -p packages/agent --noEmit && tsc -p packages/client --noEmit && tsc -p packages/less --noEmit`
Expected: All packages typecheck clean.

**Step 2: Commit if any fixups needed**

If any existing tests needed minor adjustments (e.g., mock data shape changes), commit those as a separate fixup.

```bash
git commit -m "test: verify existing suite unaffected by protocol extensions"
```
<!-- END_TASK_11 -->
