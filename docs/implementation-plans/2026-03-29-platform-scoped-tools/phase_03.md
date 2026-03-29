# Platform-Scoped Tools Implementation Plan — Phase 3

**Goal:** `AgentLoop.executeToolCall()` routes platform tool calls before reaching the sandbox. `assembleContext()` injects the silence-semantics system message when `platformContext` is set.

**Architecture:** Both changes are isolated to `packages/agent/`. The `executeToolCall()` dispatch check is inserted before the existing bash check, following a strict priority: platformTools → bash → sandbox. The `assembleContext()` change follows the exact same volatile-context-injection pattern already used for `relayInfo`.

**Tech Stack:** TypeScript 6.x, `@bound/agent`, bun:test

**Scope:** Phase 3 of 4 from the original design

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### platform-scoped-tools.AC3: AgentLoop platform tool dispatch
- **platform-scoped-tools.AC3.1 Success:** Tool call matching a `platformTools` key → `execute()` called, result returned; `sandbox.exec()` is NOT called
- **platform-scoped-tools.AC3.2 Success:** Tool call not in `platformTools` → falls through to existing sandbox dispatch unchanged

### platform-scoped-tools.AC5: System message injection
- **platform-scoped-tools.AC5.1 Success:** `assembleContext()` with `platformContext: { platform: "discord" }` → assembled messages include a `system` entry mentioning `discord_send_message` and the silence/invisibility semantics
- **platform-scoped-tools.AC5.2 Success:** `assembleContext()` without `platformContext` → no platform-specific system message added

---

## Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Insert `platformTools` dispatch into `AgentLoop.executeToolCall()`

**Verifies:** platform-scoped-tools.AC3.1, platform-scoped-tools.AC3.2

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:948-968`

**Implementation:**

The current `executeToolCall()` method (starting at line 948) has this structure:
```typescript
private async executeToolCall(toolCall: ParsedToolCall): Promise<string | RelayToolCallRequest> {
  if (!this.sandbox.exec) {
    return "Error: sandbox execution not available";
  }

  let commandString: string;

  if (toolCall.name === "bash" && typeof toolCall.input.command === "string") {
    // Bash tool: pass the command directly
    commandString = toolCall.input.command;
  } else {
    // ...JSON-encode args...
    commandString = `${toolCall.name} --_json '${jsonArgs}'`;
  }

  const result = await this.sandbox.exec(commandString);
  // ...
```

Insert the `platformTools` check BEFORE the `!this.sandbox.exec` guard. The platformTools path is entirely independent of the sandbox:

```typescript
private async executeToolCall(toolCall: ParsedToolCall): Promise<string | RelayToolCallRequest> {
  // Priority 1: Check platform tools — these bypass the sandbox entirely.
  const platformTool = this.config.platformTools?.get(toolCall.name);
  if (platformTool) {
    return platformTool.execute(toolCall.input);
  }

  // Priority 2: Sandbox dispatch (existing logic — unchanged below this line)
  if (!this.sandbox.exec) {
    return "Error: sandbox execution not available";
  }
  // ... rest of existing code unchanged ...
```

The `toolCall.input` is typed as `Record<string, unknown>` in `ParsedToolCall` — no cast is needed.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 4)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Inject `platformContext` system message in `assembleContext()`

**Verifies:** platform-scoped-tools.AC5.1, platform-scoped-tools.AC5.2

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` — two changes:
  1. Destructure `platformContext` from params (around line 89-101)
  2. Inject volatile system message after `relayInfo` block (around line 539-543)
- Modify: `packages/agent/src/agent-loop.ts:147-157` — pass `platformContext` to `assembleContext()`

**Implementation:**

**Change 1:** In `assembleContext()`, add `platformContext` to the destructured params at the top of the function body (around line 89):

```typescript
export function assembleContext(params: ContextParams): LLMMessage[] {
  const {
    db,
    threadId,
    userId,
    noHistory = false,
    configDir = "config",
    currentModel,
    contextWindow = 8000,
    hostName,
    siteId,
    relayInfo,
    platformContext,  // ← add this
  } = params;
```

**Change 2:** In Stage 6 ASSEMBLY, inside the volatile context block (inside the `if (!noHistory)` block, after the `relayInfo` injection around line 539), add the platform system message. The pattern follows `relayInfo` exactly:

```typescript
// AC5.4: Model location when inference is relayed
if (relayInfo) {
  volatileLines.push(
    `You are: ${relayInfo.model} (via ${relayInfo.provider} on host ${relayInfo.remoteHost}, relayed from ${relayInfo.localHost})`,
  );
}

// Platform silence semantics: user only sees what you explicitly send.
// NOTE: The tool name below is Discord-specific for the current single-platform
// scope. When a second platform is added, extend ContextParams.platformContext
// to carry { platform: string; toolNames: string[] } and reference tool names
// dynamically here rather than hardcoding "discord_send_message".
if (platformContext) {
  volatileLines.push("");
  volatileLines.push(
    `## Platform Context: ${platformContext.platform}`,
  );
  volatileLines.push(
    "The user of this conversation is on an external platform and cannot see your responses directly.",
  );
  volatileLines.push(
    `To send a message to the user, call the \`discord_send_message\` tool. ` +
    "If you do not call it, the user sees nothing (silence).",
  );
  volatileLines.push(
    "Each call to the tool produces one separate message to the user. " +
    "Multiple calls are allowed and delivered in order.",
  );
}
```

**Change 3:** In `AgentLoop.run()`, pass `platformContext` to `assembleContext()` (around line 147):

```typescript
const contextMessages = assembleContext({
  db: this.ctx.db,
  threadId: this.config.threadId,
  taskId: this.config.taskId,
  userId: this.config.userId,
  currentModel: this.config.modelId,
  contextWindow: contextWindow,
  hostName: this.ctx.hostName,
  siteId: this.ctx.siteId,
  relayInfo,
  platformContext: this.config.platform ? { platform: this.config.platform } : undefined,  // ← add this
});
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 4)
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Write tests for platform tool dispatch and context injection

**Verifies:** platform-scoped-tools.AC3.1, platform-scoped-tools.AC3.2, platform-scoped-tools.AC5.1, platform-scoped-tools.AC5.2

**Files:**
- Modify: `packages/agent/src/__tests__/agent-loop.test.ts` — add tests for platform tool dispatch
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts` — add tests for platformContext injection

**Context — existing agent-loop test patterns:**
The existing `agent-loop.test.ts` uses a mock `LLMBackend` and constructs `AgentLoop` with a test database and sandbox. Look at how other tests configure `AgentLoopConfig` and how they mock the LLM response. The test for platform tool dispatch needs an `AgentLoop` configured with `platformTools` in its config.

**Context — existing context-assembly test patterns:**
`context-assembly.test.ts` calls `assembleContext({ db, threadId, userId, ... })` directly with a real in-memory SQLite database. Tests assert on the returned `LLMMessage[]` array. The platformContext tests follow this same direct-call pattern.

**AC5 tests in `context-assembly.test.ts`:**

```typescript
describe("platformContext injection", () => {
  it("includes platform system message when platformContext is set (AC5.1)", () => {
    const messages = assembleContext({
      db,
      threadId,
      userId,
      platformContext: { platform: "discord" },
    });
    // Find the system message containing the silence semantics
    const systemMessages = messages.filter((m) => m.role === "system");
    const platformMsg = systemMessages.find(
      (m) => typeof m.content === "string" && m.content.includes("discord_send_message"),
    );
    expect(platformMsg).toBeDefined();
    expect(platformMsg?.content).toContain("discord_send_message");
    // Should mention silence/invisibility semantics
    expect(platformMsg?.content).toMatch(/sees nothing|silence|cannot see/i);
  });

  it("no platform system message when platformContext is absent (AC5.2)", () => {
    const messages = assembleContext({
      db,
      threadId,
      userId,
      // no platformContext
    });
    const systemMessages = messages.filter((m) => m.role === "system");
    const platformMsg = systemMessages.find(
      (m) => typeof m.content === "string" && m.content.includes("discord_send_message"),
    );
    expect(platformMsg).toBeUndefined();
  });
});
```

**AC3 tests in `agent-loop.test.ts`:**

For AC3.1 and AC3.2, you need an `AgentLoop` instance with a mock LLM that returns a tool call response. Look at existing tests that use `setToolThenTextResponse()` on the mock backend.

The key difference: configure `AgentLoopConfig.platformTools` with a spy function for AC3.1 (tool name matches a platform tool), and omit `platformTools` or use a non-matching name for AC3.2.

For AC3.1: assert that the platform tool's `execute` was called and `sandbox.exec` was NOT called.
For AC3.2: assert that `sandbox.exec` WAS called (the existing sandbox fallthrough path).

Since constructing a full `AgentLoop` requires a real database, real `AppContext`, and a mock model router, look at how `agent-loop.test.ts` already sets these up. The test structure will mirror what exists — just add a `platformTools` config option and verify dispatch.

**Verification:**
Run: `bun test packages/agent --test-name-pattern "platformContext|platform tool dispatch"`
Expected: All new tests pass

**Commit:** (part of phase commit — see Task 4)
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Run all agent tests and commit

**Verifies:** All Phase 3 ACs

**Files:** No changes — verification and commit

**Step 1: Run all agent tests**

```bash
bun test packages/agent
```

Expected: All tests pass. If any pre-existing tests fail, investigate before committing.

**Step 2: Run typecheck**

```bash
tsc -p packages/agent --noEmit
```

Expected: No errors.

**Step 3: Commit**

```bash
git add packages/agent/src/agent-loop.ts \
        packages/agent/src/context-assembly.ts \
        packages/agent/src/__tests__/agent-loop.test.ts \
        packages/agent/src/__tests__/context-assembly.test.ts
git commit -m "feat(agent): platform tool dispatch in executeToolCall, platformContext injection in assembleContext"
```
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
