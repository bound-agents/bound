# Platform-Scoped Tools Implementation Plan — Phase 4

**Goal:** `executeProcess()` looks up the active connector, injects platform tools into the loop config, suppresses auto-delivery when `payload.platform` is non-null, and the CLI wires the registry into the relay processor.

**Architecture:** `RelayProcessor` gains a `setPlatformConnectorRegistry()` setter (mirroring the existing `setAgentLoopFactory()` pattern). `executeProcess()` checks `payload.platform`, fetches the connector via `registry.getConnector()`, calls `connector.getPlatformTools(threadId)`, and merges the tool definitions and map into the `AgentLoopConfig`. The auto-deliver block at the end of `executeProcess()` is skipped when `payload.platform` is non-null. `start.ts` calls the new setter after `setAgentLoopFactory()`.

**Tech Stack:** TypeScript 6.x, `@bound/agent`, `@bound/platforms`, `@bound/cli`, bun:test

**Scope:** Phase 4 of 4 from the original design

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### platform-scoped-tools.AC6: End-to-end wiring and auto-deliver suppression
- **platform-scoped-tools.AC6.1 Success:** Discord context, agent calls `send_message` → connector `deliver()` invoked
- **platform-scoped-tools.AC6.2 Success:** Discord context, agent never calls `send_message` → `deliver()` is NOT invoked
- **platform-scoped-tools.AC6.3 Success:** Non-platform context (`platform = null`) → existing auto-deliver behavior is preserved
- **platform-scoped-tools.AC6.4 Success:** `RelayProcessor` without a registry (registry not yet set) → gracefully falls back to no platform tools injected

---

## Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add `setPlatformConnectorRegistry()` setter to `RelayProcessor`

**Verifies:** platform-scoped-tools.AC6.4 (graceful fallback when registry not set)

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` — add import, field, and setter method

**Context:** `RelayProcessor` already uses setter injection for `agentLoopFactory` (line 73-75). The registry follows the same pattern. The `PlatformConnectorRegistry` type lives in `packages/platforms/`, but `packages/agent/` does NOT import from `packages/platforms/` (that would create a circular dependency since platforms → agent isn't currently the case but we must be careful).

To avoid a cross-package dependency, import only the *interface* `PlatformConnector` indirectly via a minimal duck-typed interface, or import `PlatformConnectorRegistry` as a type-only import if `@bound/platforms` is already in `agent`'s `package.json` dependencies. Check `packages/agent/package.json` to confirm.

**If `@bound/platforms` is NOT in `agent`'s dependencies:** Define a minimal local interface in `relay-processor.ts`:

```typescript
/** Minimal interface for connector registry — avoids cross-package dep. */
interface ConnectorRegistry {
  getConnector(platform: string): {
    getPlatformTools?(threadId: string): Map<string, {
      toolDefinition: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
      execute: (input: Record<string, unknown>) => Promise<string>;
    }>;
  } | undefined;
}
```

**If `@bound/platforms` IS in `agent`'s dependencies:** Use a type-only import:
```typescript
import type { PlatformConnectorRegistry } from "@bound/platforms";
```

In either case, add a private field and setter to `RelayProcessor`:

```typescript
private platformConnectorRegistry: ConnectorRegistry | null = null;  // or PlatformConnectorRegistry

/** Inject the platform connector registry after startup completes (avoids circular init order). */
setPlatformConnectorRegistry(registry: ConnectorRegistry): void {  // or PlatformConnectorRegistry
  this.platformConnectorRegistry = registry;
}
```

Place the setter immediately after `setAgentLoopFactory()` (around line 75).

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No errors. Check `packages/agent/package.json` for the `@bound/platforms` dependency before choosing the import strategy.

**Commit:** (part of phase commit — see Task 4)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Modify `executeProcess()` to inject platform tools and suppress auto-deliver

**Verifies:** platform-scoped-tools.AC6.1, platform-scoped-tools.AC6.2, platform-scoped-tools.AC6.3, platform-scoped-tools.AC6.4

**Files:**
- Modify: `packages/agent/src/relay-processor.ts:983-1126` (the `executeProcess()` private method)

**Context:** The current `executeProcess()` method:
1. Validates model router and message presence
2. Builds a minimal `AgentLoopConfig` (`threadId`, `userId`, `taskId`)
3. Uses `agentLoopFactory` if available, else falls back to direct `AgentLoop` construction
4. Runs the loop and emits `status_forward`
5. On success, checks `thread.interface !== "web"` and emits `platform:deliver` with the last assistant message (the auto-deliver block at lines 1087-1119)

**Change 1:** After the `loopConfig` construction (around line 1056), inject platform tools when `payload.platform` is non-null:

```typescript
const loopConfig: AgentLoopConfig = {
  threadId: payload.thread_id,
  userId: payload.user_id,
  taskId: `delegated-${entry.id}`,
};

// Inject platform tools when running in a platform context
if (payload.platform && this.platformConnectorRegistry) {
  const connector = this.platformConnectorRegistry.getConnector(payload.platform);
  if (connector?.getPlatformTools) {
    const platformTools = connector.getPlatformTools(payload.thread_id);
    // Merge platform tool definitions into the tools list
    const platformToolDefs = Array.from(platformTools.values()).map((t) => t.toolDefinition);
    loopConfig.platform = payload.platform;
    loopConfig.platformTools = platformTools;
    // agentLoopFactory merges config.tools ?? [sandboxTool]; platform tools append here
    // so the LLM sees both bash and discord_send_message
    loopConfig.tools = platformToolDefs;  // factory will merge with sandboxTool via ?? logic
  }
}
```

Wait — looking at `agentLoopFactory` in `start.ts:524-532`:
```typescript
const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
  return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
    ...config,
    tools: config.tools ?? [sandboxTool],
  });
};
```

The factory does `config.tools ?? [sandboxTool]`. If we set `loopConfig.tools = platformToolDefs`, the factory will use ONLY platform tool defs (not sandboxTool). The design says "LLM sees: bash + discord_send_message". So we need to pass both.

However, `RelayProcessor` doesn't have access to `sandboxTool`. The clean solution is to NOT set `loopConfig.tools` and let the factory apply its default `[sandboxTool]`. Instead, set only `loopConfig.platform` and `loopConfig.platformTools`. The factory will set tools to `[sandboxTool]`, but the `AgentLoop` also needs the platform tool definitions in its tools list for the LLM to know about them.

The fix: the `agentLoopFactory` in `start.ts` should be updated to merge platform tool definitions when `config.platformTools` is set. Update `agentLoopFactory` in `start.ts`:

```typescript
const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
  if (!modelRouter) {
    throw new Error("agentLoopFactory called without a configured model router");
  }
  const platformToolDefs = config.platformTools
    ? Array.from(config.platformTools.values()).map((t) => t.toolDefinition)
    : [];
  return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
    ...config,
    tools: [...(config.tools ?? [sandboxTool]), ...platformToolDefs],
  });
};
```

With this approach, `loopConfig.tools` is NOT set in `relay-processor.ts`. Instead, only `loopConfig.platform` and `loopConfig.platformTools` are set, and the factory handles merging. This keeps `relay-processor.ts` free of knowledge about `sandboxTool`.

**Corrected injection in `relay-processor.ts`:**

```typescript
// Inject platform tools when running in a platform context
if (payload.platform && this.platformConnectorRegistry) {
  const connector = this.platformConnectorRegistry.getConnector(payload.platform);
  if (connector?.getPlatformTools) {
    const platformTools = connector.getPlatformTools(payload.thread_id);
    loopConfig.platform = payload.platform;
    loopConfig.platformTools = platformTools;
  }
}
```

**Change 2:** Suppress the auto-deliver block when `payload.platform` is non-null. The auto-deliver block starts at approximately line 1087:

```typescript
// BEFORE (existing code — auto-deliver on success):
if (result.error) {
  this.writeResponse(entry, "error", JSON.stringify({ error: result.error, retriable: false }));
} else {
  this.writeResponse(entry, "result", JSON.stringify({ success: true }));

  const thread = this.db
    .query<{ interface: string }, [string]>(...)
    .get(payload.thread_id);
  if (thread && thread.interface !== "web") {
    // ... auto-deliver block ...
    this.eventBus.emit("platform:deliver", { ... });
  }
}

// AFTER (suppress auto-deliver for platform contexts):
if (result.error) {
  this.writeResponse(entry, "error", JSON.stringify({ error: result.error, retriable: false }));
} else {
  this.writeResponse(entry, "result", JSON.stringify({ success: true }));

  // Auto-deliver is suppressed when running in a platform context.
  // In platform contexts the agent calls discord_send_message (or equivalent)
  // explicitly. Auto-deliver is only used for non-platform (web UI) contexts.
  if (!payload.platform) {
    const thread = this.db
      .query<{ interface: string }, [string]>(
        "SELECT interface FROM threads WHERE id = ? AND deleted = 0 LIMIT 1",
      )
      .get(payload.thread_id);
    if (thread && thread.interface !== "web") {
      const lastAssistant = this.db
        .query<{ id: string; content: string }, [string]>(
          "SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(payload.thread_id);
      if (lastAssistant) {
        let textContent = lastAssistant.content;
        try {
          const parsed = JSON.parse(lastAssistant.content);
          if (Array.isArray(parsed)) {
            textContent = parsed
              .filter((b: { type: string; text?: string }) => b.type === "text")
              .map((b: { text?: string }) => b.text ?? "")
              .join("");
          }
        } catch {
          // already a plain string
        }
        if (!textContent.trim()) return;
        this.eventBus.emit("platform:deliver", {
          platform: thread.interface,
          thread_id: payload.thread_id,
          message_id: lastAssistant.id,
          content: textContent,
        } satisfies PlatformDeliverPayload);
      }
    }
  }
}
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 4)
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Wire `setPlatformConnectorRegistry()` in `start.ts`

**Verifies:** platform-scoped-tools.AC6.1 (end-to-end wiring)

**Files:**
- Modify: `packages/cli/src/commands/start.ts:534-535`

**Context:** The current wiring at line 534-535:
```typescript
// Wire the factory into the relay processor so process relays run with full sandbox + tools.
relayProcessor.setAgentLoopFactory(agentLoopFactory);
```

**Change 1:** Update `agentLoopFactory` to merge platform tool definitions (as described in Task 2). Find the factory definition at line 524 and update it:

```typescript
const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
  if (!modelRouter) {
    throw new Error("agentLoopFactory called without a configured model router");
  }
  const platformToolDefs = config.platformTools
    ? Array.from(config.platformTools.values()).map((t) => t.toolDefinition)
    : [];
  return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
    ...config,
    tools: [...(config.tools ?? [sandboxTool]), ...platformToolDefs],
  });
};
```

**Change 2:** Inside the existing `if (platformsResult?.ok)` block (around line 749-759), call `setPlatformConnectorRegistry()` immediately after `start()`:

```typescript
// In the platform connectors block (around line 749-759):
if (platformsResult?.ok) {
  const { PlatformConnectorRegistry } = await import("@bound/platforms");
  const platformsConfig = platformsResult.value as import("@bound/shared").PlatformsConfig;
  platformRegistry = new PlatformConnectorRegistry(appContext, platformsConfig);
  platformRegistry.start();
  // Wire into relay processor for platform-context process relays
  relayProcessor.setPlatformConnectorRegistry(platformRegistry);
  console.log("[platforms] Platform connector registry started");
}
```

Note: `relayProcessor` is declared before this block (line 460), so it is in scope. `PlatformConnectorRegistry` is available within the block via the dynamic import. No type narrowing or `instanceof` check is needed — the call happens directly inside the block where the registry is created.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Write integration tests for auto-deliver suppression and platform tool injection

**Verifies:** platform-scoped-tools.AC6.1, platform-scoped-tools.AC6.2, platform-scoped-tools.AC6.3, platform-scoped-tools.AC6.4

**Files:**
- Modify: `packages/agent/src/__tests__/relay-processor.test.ts` — add tests for platform context behavior

**Context:** Look at `relay-processor.test.ts` to understand how it sets up `RelayProcessor` instances for testing. The existing tests likely use a real SQLite database with schema applied, a mock `ModelRouter`, and construct `RelayProcessor` directly. The new tests extend this pattern.

For AC6.1 and AC6.2: You need a `RelayProcessor` with:
- A mock `agentLoopFactory` that can report what `AgentLoopConfig` it was called with
- A mock `ConnectorRegistry` with a mock connector that has `getPlatformTools()` returning a mock tool
- A `ProcessPayload` with `platform: "discord"`

For AC6.1: Mock the `agentLoopFactory` to simulate the agent calling `discord_send_message`. Since the agent loop is mocked, the simplest test is to verify that `loopConfig.platform` and `loopConfig.platformTools` are set when calling the factory.

For AC6.2: Verify that the auto-deliver `platform:deliver` event is NOT emitted when `payload.platform` is non-null, even if the agent produces an assistant message.

For AC6.3: Set `payload.platform = null` and verify the auto-deliver `platform:deliver` event IS emitted (existing behavior preserved).

For AC6.4: Create a `RelayProcessor` without calling `setPlatformConnectorRegistry()`. Set `payload.platform = "discord"`. Verify it falls back gracefully (no crash, no platform tools injected, loop still runs).

**Testing approach:**

```typescript
describe("executeProcess platform context", () => {
  it("injects platform tools into loop config when registry is set (AC6.4 setup + AC6.1 precondition)", async () => {
    // Setup: relay processor with mock registry, mock agentLoopFactory
    // Capture: what loopConfig was passed to agentLoopFactory
    // Assert: loopConfig.platform === "discord"
    // Assert: loopConfig.platformTools is a Map with "discord_send_message"
  });

  it("does not emit platform:deliver when payload.platform is non-null (AC6.2)", async () => {
    // Setup: listen for platform:deliver on eventBus
    // Run: process a relay with platform: "discord", agent produces an assistant message
    // Assert: platform:deliver was NOT emitted
  });

  it("emits platform:deliver when payload.platform is null (AC6.3)", async () => {
    // Setup: thread with interface != "web", listen for platform:deliver
    // Run: process a relay with platform: null
    // Assert: platform:deliver was emitted with the last assistant message
  });

  it("gracefully proceeds when registry is not set (AC6.4)", async () => {
    // Setup: relay processor WITHOUT setPlatformConnectorRegistry()
    // Capture: loopConfig passed to agentLoopFactory
    // Assert: loopConfig.platform is undefined
    // Assert: loopConfig.platformTools is undefined
    // Assert: no crash
  });
});
```

Use `randomBytes(4).toString("hex")` for test database paths, consistent with the existing test patterns.

**Verification:**
Run: `bun test packages/agent --test-name-pattern "platform context"`
Expected: All new tests pass

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Run full test suite and commit

**Verifies:** All Phase 4 ACs

**Files:** No changes — verification and commit

**Step 1: Run all package tests**

```bash
bun test packages/agent
bun test packages/cli
bun test packages/platforms
```

Expected: All tests pass. If any pre-existing tests fail, investigate before committing.

**Step 2: Run full typecheck**

```bash
bun run typecheck
```

Expected: All packages compile cleanly.

**Step 3: Commit all Phase 4 changes**

```bash
git add packages/agent/src/relay-processor.ts \
        packages/cli/src/commands/start.ts \
        packages/agent/src/__tests__/relay-processor.test.ts
git commit -m "feat(agent,cli): wire platform connector registry, inject platform tools in executeProcess, suppress auto-deliver for platform contexts"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->
