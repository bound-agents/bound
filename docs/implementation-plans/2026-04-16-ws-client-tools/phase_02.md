# WebSocket Client Tools Implementation Plan — Phase 2

**Goal:** Agent loop recognizes client tools, returns a sentinel for them, persists tool_call messages, writes dispatch_queue entries, and yields after processing all tools in a turn.

**Architecture:** `ClientToolCallRequest` sentinel type (analogous to `RelayToolCallRequest` in `mcp-bridge.ts:73`). Client tools slot into `executeToolCall()` dispatch chain at priority 2 (after platform tools at line 1485, before built-in tools at line 1492). TOOL_EXECUTE state at line 804 gains a third branch alongside relay detection. When client tool calls are present in a turn, the loop persists all tool_call messages but exits instead of continuing — the loop resumes when `tool_result` entries arrive in dispatch_queue.

**Tech Stack:** Bun, TypeScript, bun:sqlite

**Scope:** 8 phases from original design (this is phase 2 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC3: Client-Side Tool Registration & Execution
- **ws-client-tools.AC3.1 Success:** Client sends `session:configure` with tool definitions; agent loop includes those tools in LLM tool list
- **ws-client-tools.AC3.2 Success:** When LLM calls a client tool, client receives `tool:call` over WS with correct name and arguments
- **ws-client-tools.AC3.3 Success:** Client sends `tool:result`; agent loop resumes and LLM sees the result in context
- **ws-client-tools.AC3.4 Success:** Mixed turn with server + client tools: server tools execute eagerly, client tools deferred, loop yields after full pass

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: ClientToolCallRequest type and AgentLoopConfig.clientTools

**Verifies:** ws-client-tools.AC3.1

**Files:**
- Modify: `packages/agent/src/types.ts` (add type and config field, near `AgentLoopConfig` at line 19)

**Implementation:**

1. **`ClientToolCallRequest` interface** — Define analogous to `RelayToolCallRequest` (in `mcp-bridge.ts:73`). The sentinel needs a unique discriminant property so the TOOL_EXECUTE handler can distinguish it from normal results and relay requests.

   ```typescript
   export interface ClientToolCallRequest {
       clientToolCall: true; // discriminant (RelayToolCallRequest uses "outboxEntryId")
       toolName: string;
       callId: string;
       arguments: Record<string, unknown>;
   }
   ```

2. **`isClientToolCallRequest()` type guard** — Following `isRelayRequest()` pattern from `mcp-bridge.ts:89`:

   ```typescript
   export function isClientToolCallRequest(result: unknown): result is ClientToolCallRequest {
       return result != null && typeof result === "object" && "clientToolCall" in result;
   }
   ```

3. **Add `clientTools` to `AgentLoopConfig`** (line 19) — Optional field:

   ```typescript
   clientTools?: Map<string, { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
   ```

   This mirrors the shape of `tools` (the LLM tool definition format) but stored as a Map keyed by tool name for O(1) lookup in `executeToolCall()`. The Map stores schema-only definitions (no executor function) — the actual execution happens client-side.

Export the new type, type guard, and updated config interface.

**Testing:**

Tests must verify:
- ws-client-tools.AC3.1: `isClientToolCallRequest` returns true for objects with `clientToolCall: true` discriminant
- `isClientToolCallRequest` returns false for normal tool results `{ content, exitCode }`, relay requests with `outboxEntryId`, null, undefined, and non-objects

Add tests to: `packages/agent/src/__tests__/agent-loop.test.ts` (or a new `client-tool-dispatch.test.ts` if the existing file is too large)

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add ClientToolCallRequest type and clientTools config field`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: executeToolCall client tool dispatch and tool definition merging

**Verifies:** ws-client-tools.AC3.1, ws-client-tools.AC3.2

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (modify `executeToolCall` at line 1482, tool assembly near lines 313 and 500)

**Implementation:**

1. **Modify `executeToolCall()` return type** (line 1482) — Update signature to include `ClientToolCallRequest`:

   ```typescript
   private async executeToolCall(
       toolCall: ParsedToolCall,
   ): Promise<{ content: string; exitCode: number } | RelayToolCallRequest | ClientToolCallRequest>
   ```

2. **Add client tool check at priority 2** — Insert after platform tools check (line 1485-1490) and before built-in tools check (line 1492):

   ```typescript
   // Priority 2: Client tools (schema only, execution deferred to client)
   if (this.config.clientTools?.has(toolCall.name)) {
       return {
           clientToolCall: true,
           toolName: toolCall.name,
           callId: toolCall.id,
           arguments: toolCall.input,
       } satisfies ClientToolCallRequest;
   }
   ```

3. **Merge clientTools into LLM tool list** — Where `this.config.tools` is used for the LLM call (lines 313, 431, 500), merge in the client tool definitions. The cleanest approach: compute a merged tool array once before the while loop or at context assembly time.

   Add a private method or compute at loop entry (near line 313):
   ```typescript
   private getMergedTools(): Array<{ type: "function"; function: {...} }> | undefined {
       const serverTools = this.config.tools ?? [];
       const clientTools = this.config.clientTools
           ? Array.from(this.config.clientTools.values())
           : [];
       const merged = [...serverTools, ...clientTools];
       return merged.length > 0 ? merged : undefined;
   }
   ```

   Replace `this.config.tools` with `this.getMergedTools()` at:
   - Line 313 (token estimation)
   - Line 431 (remote inference payload)
   - Line 500 (local inference `backend.chat()`)

**Testing:**

Tests must verify:
- ws-client-tools.AC3.1: When `clientTools` has entries, the LLM tool list includes both server tools and client tool definitions
- ws-client-tools.AC3.2: When LLM calls a tool name that matches a client tool, `executeToolCall` returns a `ClientToolCallRequest` with correct `toolName`, `callId`, and `arguments`
- Client tools are checked after platform tools but before built-in tools (priority ordering)
- When `clientTools` is undefined/empty, behavior is unchanged from current

Add tests to: `packages/agent/src/__tests__/agent-loop.test.ts` or new `packages/agent/src/__tests__/client-tool-dispatch.test.ts`

Use the existing `MockLLMBackend` pattern. Configure a mock that returns a `tool_use` block targeting a client tool name, verify `executeToolCall` returns the sentinel.

**Verification:**
Run: `bun test packages/agent/src/__tests__/agent-loop.test.ts`
Expected: All existing + new tests pass

**Commit:** `feat(agent): client tool dispatch in executeToolCall and tool list merging`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: TOOL_EXECUTE handles ClientToolCallRequest — persist and yield

**Verifies:** ws-client-tools.AC3.3, ws-client-tools.AC3.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (TOOL_EXECUTE state at lines 804-940)
- Modify: `packages/shared/src/events.ts` (add `client_tool_call:created` to EventMap)

**Implementation:**

**Prerequisite: Add `client_tool_call:created` event to EventMap** — In `packages/shared/src/events.ts`, add a new event to the `EventMap` interface:

```typescript
"client_tool_call:created": { threadId: string; callId: string; toolName: string; arguments: Record<string, unknown> };
```

This event is emitted after enqueueing a client tool call, allowing the WS handler (Phase 3) to deliver `tool:call` messages to connected clients in a type-safe manner.

Modify the TOOL_EXECUTE state to handle `ClientToolCallRequest` results. The key behavior difference from relay requests: client tool calls don't wait in-memory. Instead, they persist a dispatch_queue entry and the loop exits. The loop resumes when a `tool_result` dispatch_queue entry arrives.

1. **Track pending client tool calls** — Add a local array before the tool execution loop (near line 782):

   ```typescript
   const pendingClientCalls: Array<{ toolCall: ParsedToolCall; request: ClientToolCallRequest }> = [];
   ```

2. **Add ClientToolCallRequest branch** in the result handling (lines 804-809) — After the relay request check (`"outboxEntryId" in result`), add:

   ```typescript
   if (isClientToolCallRequest(result)) {
       pendingClientCalls.push({ toolCall, request: result });
       // Don't set resultContent — no result yet
       // Skip adding to toolResults for now
       continue; // Process next tool call in the turn
   }
   ```

3. **After all tool calls in the turn are processed** — Check if any client tool calls were deferred. If so:
   - Persist all tool_call messages (both server-executed and client-deferred) as usual
   - For server-executed tools, persist tool_result messages as usual
   - For client-deferred tools, persist only the tool_call message (no tool_result yet)
   - Call `enqueueClientToolCall()` (from Phase 1) for each deferred call
   - Set `continueLoop = false` to exit the loop

   The implementation should be after tool result persistence (around line 901):

   ```typescript
   if (pendingClientCalls.length > 0) {
       for (const { toolCall, request } of pendingClientCalls) {
           // Persist tool_call message (same pattern as lines 864-874)
           // but without a corresponding tool_result
           const toolCallMsg = insertThreadMessage(db, {
               thread_id: this.config.threadId,
               role: "tool_call",
               content: JSON.stringify([{
                   type: "tool_use",
                   id: toolCall.id,
                   name: toolCall.name,
                   input: toolCall.input,
               }]),
               user_id: this.config.userId,
           }, siteId);

           // Enqueue dispatch entry for WS delivery
           enqueueClientToolCall(db, this.config.threadId, {
               call_id: toolCall.id,
               tool_name: toolCall.name,
               arguments: toolCall.input,
           }, this.config.connectionId);

           // Emit event for WS handler to deliver tool:call to client
           this.appContext.eventBus.emit("client_tool_call:created", {
               threadId: this.config.threadId,
               callId: toolCall.id,
               toolName: toolCall.name,
               arguments: toolCall.input,
           });
       }
       continueLoop = false; // Exit loop — resume on tool_result
   }
   ```

4. **Connection ID** — The `enqueueClientToolCall` requires a `connectionId`. Add `connectionId: string` (required, not optional) to `AgentLoopConfig`. It's set by Phase 4 when `handleThread` resolves client tools from the connection registry. Tests pass a synthetic connectionId value (e.g., `"test-connection-id"`).

**Testing:**

Tests must verify:
- ws-client-tools.AC3.3: After a client tool call is deferred and the loop exits, inserting a `tool_result` dispatch_queue entry causes the loop to resume (when re-triggered). On resume, the LLM sees the tool_call/tool_result pair in context.
- ws-client-tools.AC3.4: In a turn with both server tools and client tools, server tools execute immediately (tool_result persisted), client tools are deferred (only tool_call persisted), and the loop exits after the full pass. Verify both tool_call messages are persisted but only the server tool has a tool_result.

Use the existing `MockLLMBackend.setToolThenTextResponse()` pattern but configure it to return BOTH a server tool call and a client tool call in the same turn. Verify the server tool executes inline and the client tool produces a `ClientToolCallRequest`.

Add tests to: `packages/agent/src/__tests__/client-tool-dispatch.test.ts` (or integrate into existing agent-loop tests)

**Verification:**
Run: `bun test packages/agent`
Expected: All existing + new tests pass

**Commit:** `feat(agent): TOOL_EXECUTE handles ClientToolCallRequest with persist and yield`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Agent loop resume on tool_result

**Verifies:** ws-client-tools.AC3.3

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (context assembly area, around lines 300-400)

**Implementation:**

When the agent loop resumes after a `tool_result` dispatch_queue entry, the context assembly pipeline must include the tool_call/tool_result message pairs from the deferred client tool calls. This should work automatically if:

1. The tool_call messages were persisted correctly (Task 3 handles this)
2. The tool_result messages are persisted before the loop resumes (Phase 3's WS handler will do this)
3. The context assembly pipeline picks up all messages for the thread (it already does)

Verify that no special handling is needed in the context assembly pipeline. The tool_call messages (role: "tool_call") and tool_result messages (role: "tool_result") should be picked up by the existing message retrieval in Stage 1 (MESSAGE_RETRIEVAL).

The main concern is the **TOOL_PAIR_SANITIZATION** stage (Stage 3 in context assembly) — it injects synthetic tool_call/tool_result pairs to maintain pairing invariants. Verify that the client tool_call messages (which may temporarily lack tool_result pairs between loop exit and tool_result arrival) don't cause issues. Since the loop only resumes AFTER tool_result is persisted, by the time context assembly runs, the pair should be complete.

If context assembly has any logic that validates tool_call/tool_result pairing and flags unpaired entries, document it so the executor knows what to verify.

**Testing:**

Tests must verify:
- ws-client-tools.AC3.3: Full round-trip: LLM produces client tool call → loop exits → tool_result message persisted → loop resumes → LLM sees complete tool_call/tool_result pair in context → produces final response

This is an integration-level test. Set up:
1. MockLLMBackend with two responses: first returns tool_use for a client tool, second returns text
2. AgentLoop with clientTools configured
3. Run loop — verify it exits after first turn
4. Insert tool_result message + enqueue tool_result dispatch entry
5. Re-run loop — verify LLM receives the tool_call/tool_result pair and produces final response

Add tests to: `packages/agent/src/__tests__/client-tool-dispatch.test.ts`

**Verification:**
Run: `bun test packages/agent/src/__tests__/client-tool-dispatch.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): verify agent loop resume with client tool results in context`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->
