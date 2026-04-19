# Boundless Implementation Plan — Phase 5: Session Management

**Goal:** Implement the attach flow for connecting to threads, thread transitions (/attach, /clear) with rollback semantics, and the Ctrl-C cancellation state machine.

**Architecture:** Three modules in `packages/less/src/session/`: `attach.ts` for the ordered attach sequence, `transition.ts` for thread switching with lock management, and `cancel.ts` for the Ctrl-C state machine. All orchestrate lower-level primitives from Phases 2-4 (lockfile, registry, MCP manager, BoundClient).

**Tech Stack:** TypeScript, @bound/client (BoundClient), bun:test

**Scope:** 8 phases from original design (phase 5 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC7: Session Management
- **boundless.AC7.1 Success:** Attach flow executes in order: listMessages, subscribe, ensure MCP servers, build tools, configure
- **boundless.AC7.2 Success:** Pending tool calls in history rendered as placeholders, replaced when re-delivered
- **boundless.AC7.3 Success:** `/attach <threadId>` transitions: drain, unsubscribe old, release old lock, acquire new lock, attach new
- **boundless.AC7.4 Success:** `/clear` creates new thread and transitions to it; model selection preserved
- **boundless.AC7.5 Success:** Transition failure at lock acquisition triggers rollback to old thread
- **boundless.AC7.6 Edge:** Rollback failure (another process grabbed old lock) enters degraded read-only mode with persistent banner
- **boundless.AC7.7 Success:** Ctrl-C during active turn calls cancelThread once, aborts in-flight tool handlers
- **boundless.AC7.8 Success:** Double Ctrl-C within 2s exits gracefully (MCP terminated, lock released)
- **boundless.AC7.9 Success:** Ctrl-C during idle shows hint; second within 2s exits
- **boundless.AC7.10 Success:** Ctrl-C while modal open dismisses modal without counting toward exit
- **boundless.AC7.11 Edge:** Ctrl-C during attach transition deferred until transition settles

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Attach flow

**Verifies:** boundless.AC7.1, boundless.AC7.2

**Files:**
- Create: `packages/less/src/session/attach.ts`
- Test: `packages/less/src/__tests__/session-attach.test.ts`

**Implementation:**

Export `performAttach(params: AttachParams): Promise<AttachResult>`:

```ts
interface AttachParams {
    client: BoundClient;
    threadId: string;
    mcpManager: McpServerManager;
    mcpConfigs: McpServerConfig[];
    cwd: string;
    hostname: string;
    logger: AppLogger;
    confirmFn?: (toolName: string) => Promise<boolean>;
}

interface AttachResult {
    messages: Message[];
    pendingToolCallIds: string[];
    mcpFailures: Array<{ serverName: string; error: string }>;
}
```

The attach flow executes in strict order (AC7.1):

1. **listMessages**: `const messages = await client.listMessages(threadId)`. Scan messages for pending tool calls — messages with `role: "tool_call"` that don't have a corresponding `role: "tool_result"` with matching `tool_name` (which stores the callId). Collect these as `pendingToolCallIds` (AC7.2).

2. **subscribe**: `client.subscribe(threadId)`.

3. **ensure MCP servers**: `await mcpManager.ensureAllEnabled(mcpConfigs)`. Collect failures from servers that failed to spawn/connect — these are non-fatal.

4. **build tools**: Call `buildToolSet(cwd, hostname, mcpManager.getRunningTools(), confirmFn)` from registry.

5. **configure**: `client.configureTools(toolSet.tools, { systemPromptAddition: buildSystemPromptAddition(cwd, hostname, mcpServerNames) })`.

Return messages, pending tool call IDs, and MCP failures.

**Testing:**

- boundless.AC7.1: Mock BoundClient methods, call performAttach, verify methods called in order: listMessages → subscribe → ensureAllEnabled → buildToolSet → configureTools
- boundless.AC7.2: Provide message history with an unpaired tool_call, verify it appears in pendingToolCallIds

**Verification:**
Run: `bun test packages/less/src/__tests__/session-attach.test.ts`
Expected: All tests pass

**Commit:** `feat(less): session attach flow with ordered initialization`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Thread transitions with rollback

**Verifies:** boundless.AC7.3, boundless.AC7.4, boundless.AC7.5, boundless.AC7.6

**Files:**
- Create: `packages/less/src/session/transition.ts`
- Test: `packages/less/src/__tests__/session-transition.test.ts`

**Implementation:**

Export `transitionThread(params: TransitionParams): Promise<TransitionResult>`:

```ts
interface TransitionParams {
    client: BoundClient;
    oldThreadId: string;
    newThreadId: string; // may be null for /clear (creates new thread)
    configDir: string;
    cwd: string;
    hostname: string;
    mcpManager: McpServerManager;
    mcpConfigs: McpServerConfig[];
    logger: AppLogger;
    inFlightTools: Map<string, AbortController>; // from useToolCalls hook
    confirmFn?: (toolName: string) => Promise<boolean>;
    model?: string | null; // preserved across /clear
}

type TransitionResult =
    | { ok: true; attachResult: AttachResult; threadId: string }
    | { ok: false; error: string; degraded: boolean };
```

**Transition sequence** (AC7.3):

1. **Drain in-flight tools**: Abort all controllers in `inFlightTools` map. Wait up to 500ms for handlers to complete.

2. **Unsubscribe old**: `client.unsubscribe(oldThreadId)`.

3. **Release old lock**: `releaseLock(configDir, oldThreadId)`.

4. **Create thread if /clear** (AC7.4): If `newThreadId` is null, `const thread = await client.createThread()` and use `thread.id`. Note: if subsequent steps fail, this creates an orphaned empty thread. This is a known trade-off per the design's "Additional Considerations" section — no client-side or server-side GC exists yet.

5. **Acquire new lock**: `acquireLock(configDir, newThreadId, cwd)`. On failure → rollback (AC7.5).

6. **Verify thread exists**: `await client.getThread(newThreadId)`. On failure → release new lock, rollback.

7. **Attach**: `await performAttach(...)`. On failure → release new lock, rollback.

**Rollback** (AC7.5): On failure at steps 5-7:
- Re-subscribe to old thread: `client.subscribe(oldThreadId)`
- Re-acquire old lock: `acquireLock(configDir, oldThreadId, cwd)`
- If rollback succeeds: return `{ ok: false, error: "...", degraded: false }`
- If rollback fails (AC7.6): another process grabbed the old lock. Return `{ ok: false, error: "...", degraded: true }`. The TUI renders a persistent banner in degraded read-only mode.

**Testing:**

- boundless.AC7.3: Mock all operations to succeed, verify drain → unsubscribe → release → acquire → attach sequence
- boundless.AC7.4: Call transition with newThreadId=null, verify createThread called, model preserved
- boundless.AC7.5: Mock acquireLock to fail on new thread, verify rollback re-subscribes and re-acquires old lock
- boundless.AC7.6: Mock both acquireLock (new) and rollback acquireLock (old) to fail, verify degraded=true

**Verification:**
Run: `bun test packages/less/src/__tests__/session-transition.test.ts`
Expected: All tests pass

**Commit:** `feat(less): thread transitions with rollback and degraded mode`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Ctrl-C cancellation state machine

**Verifies:** boundless.AC7.7, boundless.AC7.8, boundless.AC7.9, boundless.AC7.10, boundless.AC7.11

**Files:**
- Create: `packages/less/src/session/cancel.ts`
- Test: `packages/less/src/__tests__/session-cancel.test.ts`

**Implementation:**

Export `CancelStateMachine` class:

```ts
interface CancelDeps {
    cancelThread: (threadId: string) => Promise<void>;
    abortInFlightTools: () => void;
    gracefulExit: () => Promise<void>;
    dismissModal: () => boolean; // returns true if modal was open and dismissed
    showHint: (message: string) => void;
}

class CancelStateMachine {
    private lastCtrlCTime = 0;
    private canceledThisTurn = false;
    turnActive = false;
    modalOpen = false;
    transitionInFlight = false;

    constructor(
        private threadId: string,
        private deps: CancelDeps,
    ) {}
```

**`onCtrlC()` state machine:**

1. **Modal open** (AC7.10): `deps.dismissModal()`. Does NOT count toward exit sequence. Return.

2. **Transition in flight** (AC7.11): Set deferred flag. Return. Process deferred when transition settles.

3. **Active turn, not yet canceled** (AC7.7): Call `deps.cancelThread(threadId)` and `deps.abortInFlightTools()`. Set `canceledThisTurn = true`. Record `lastCtrlCTime`.

4. **Within 2s of last Ctrl-C** (AC7.8): Call `deps.gracefulExit()`. This terminates MCP, releases lock, disconnects, and exits.

5. **Idle, first press** (AC7.9): Show hint "Press Ctrl-C again to exit". Record `lastCtrlCTime`.

6. **Idle, within 2s of last** (AC7.9 second press): Call `deps.gracefulExit()`.

**`gracefulExit()`** should be implemented by the caller (App component), not inside the state machine. It:
- Calls `mcpManager.terminateAll()`
- Calls `releaseLock(configDir, threadId)`
- Calls `client.disconnect()`
- Calls `process.exit(0)`

**`resetTurn()`**: Called when agent turn completes. Resets `canceledThisTurn = false`, `turnActive = false`.

**Testing:**

Test all state transitions:
- boundless.AC7.7: Set turnActive=true, call onCtrlC, verify cancelThread called once and abortInFlightTools called
- boundless.AC7.8: Call onCtrlC twice within 2s, verify gracefulExit called
- boundless.AC7.9: Set turnActive=false, call onCtrlC, verify showHint called. Call again within 2s, verify gracefulExit.
- boundless.AC7.10: Set modalOpen=true, call onCtrlC, verify dismissModal called and NOT counted toward exit
- boundless.AC7.11: Set transitionInFlight=true, call onCtrlC, verify nothing happens (deferred)

**Verification:**
Run: `bun test packages/less/src/__tests__/session-cancel.test.ts`
Expected: All tests pass

**Commit:** `feat(less): Ctrl-C cancellation state machine`
<!-- END_TASK_3 -->
