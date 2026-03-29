# Platform-Scoped Tools Implementation Plan — Phase 2

**Goal:** Implement `DiscordConnector.getPlatformTools()` returning a `discord_send_message` tool with validation and delivery logic. Add `PlatformConnectorRegistry.getConnector()` for lookup by platform name.

**Architecture:** All changes stay within `packages/platforms/`. The `execute` closure captures `this` (the connector) and `threadId` so it has everything needed without ambient state. `deliver()` is updated to handle typed `{ filename, data }` attachments using discord.js v14's `channel.send({ content, files })` API.

**Tech Stack:** TypeScript 6.x, discord.js v14, `@bound/platforms`, bun:test

**Scope:** Phase 2 of 4 from the original design

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### platform-scoped-tools.AC1: `discord_send_message` validates and delivers
- **platform-scoped-tools.AC1.1 Success:** Valid content ≤ 2000 chars with no attachments → `deliver()` is called, tool returns `"sent"`
- **platform-scoped-tools.AC1.2 Success:** Valid content + readable attachment path → `deliver()` called with `{ filename, data: Buffer }`, returns `"sent"`
- **platform-scoped-tools.AC1.3 Success:** Multiple `send_message` calls in one turn → each results in a separate `deliver()` invocation, in call order
- **platform-scoped-tools.AC1.4 Failure:** Content > 2000 chars → returns error string, `deliver()` is NOT called
- **platform-scoped-tools.AC1.5 Failure:** At least one attachment path is unreadable/missing → returns error string, `deliver()` is NOT called (no partial delivery)
- **platform-scoped-tools.AC1.6 Edge:** Content exactly 2000 chars → succeeds

### platform-scoped-tools.AC2: `PlatformConnector.getPlatformTools()` interface
- **platform-scoped-tools.AC2.1 Success:** `DiscordConnector.getPlatformTools(threadId)` returns a map containing key `"discord_send_message"` with a valid `toolDefinition` (correct name, description, and parameters schema)
- **platform-scoped-tools.AC2.2 Success:** The `execute` closure in the returned map is bound to the given `threadId`

### platform-scoped-tools.AC4: `PlatformConnectorRegistry.getConnector()`
- **platform-scoped-tools.AC4.1 Success:** Known platform name → returns registered connector instance
- **platform-scoped-tools.AC4.2 Success:** Unknown platform name → returns `undefined`

---

## Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Update `DiscordConnector.deliver()` for typed attachments

**Verifies:** platform-scoped-tools.AC1.1, platform-scoped-tools.AC1.2 (delivery path)

**Files:**
- Modify: `packages/platforms/src/connectors/discord.ts:89-113`

**Implementation:**

Update `deliver()` to accept the narrowed attachment type from Phase 1 and update `getDMChannelForThread()` return type to support both text-only and file-attachment sends.

First, update the `getDMChannelForThread()` return type (line ~283). The current return type is:
```typescript
{ send(content: string): Promise<unknown> } | null
```
Change it to:
```typescript
{
  send(
    content: string | {
      content?: string;
      files?: Array<{ attachment: Buffer; name: string }>;
    }
  ): Promise<unknown>;
} | null
```

Then update `deliver()` to handle typed attachments:

```typescript
async deliver(
  threadId: string,
  _messageId: string,
  content: string,
  attachments?: Array<{ filename: string; data: Buffer }>,
): Promise<void> {
  if (!this.client) {
    throw new Error("DiscordConnector: not connected");
  }

  const channel = await this.getDMChannelForThread(threadId);

  // Stop typing indicator now that we have the channel (or failed to get it)
  this.stopTyping(threadId);

  if (!channel) {
    this.logger.warn("No DM channel found for thread", { threadId });
    return;
  }

  if (attachments && attachments.length > 0) {
    // Attachment delivery: send content + files in a single message.
    // The discord_send_message tool already validates content ≤ 2000 chars,
    // so no chunking is needed here.
    await channel.send({
      content: content || undefined,
      files: attachments.map((a) => ({ attachment: a.data, name: a.filename })),
    });
  } else {
    // Text-only delivery: chunk at Discord's 2000-character limit (AC6.3).
    for (let i = 0; i < content.length; i += 2000) {
      await channel.send(content.slice(i, i + 2000));
    }
  }
}
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No errors on the deliver() method

**Commit:** (part of phase commit — see Task 3)
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement `DiscordConnector.getPlatformTools()`

**Verifies:** platform-scoped-tools.AC1.1–AC1.6, platform-scoped-tools.AC2.1, platform-scoped-tools.AC2.2

**Files:**
- Modify: `packages/platforms/src/connectors/discord.ts` — add method after `deliver()`

**Implementation:**

Add the following import at the top of the file (alongside the existing imports):
```typescript
import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "@bound/llm";
```

Add the `getPlatformTools()` method to `DiscordConnector` after the `deliver()` method:

```typescript
getPlatformTools(threadId: string): Map<string, {
  toolDefinition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}> {
  const toolDefinition: ToolDefinition = {
    type: "function",
    function: {
      name: "discord_send_message",
      description:
        "Send a message to the Discord user in this conversation. " +
        "If you do not call this tool, the user sees nothing (silence). " +
        "Multiple calls produce multiple separate messages in order.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Text content to send. Maximum 2000 characters.",
          },
          attachments: {
            type: "array",
            description: "Optional list of absolute filesystem paths to attach.",
            items: { type: "string" },
          },
        },
        required: ["content"],
      },
    },
  };

  const execute = async (input: Record<string, unknown>): Promise<string> => {
    const content = input.content;
    const attachmentPaths = input.attachments as string[] | undefined;

    // Validate content
    if (typeof content !== "string") {
      return "Error: content must be a string";
    }
    if (content.length > 2000) {
      return `Error: content exceeds 2000 characters (got ${content.length})`;
    }

    // Load attachment files (fail-fast on first unreadable path — no partial delivery).
    // Use async readFile to avoid blocking the event loop.
    let loadedFiles: Array<{ filename: string; data: Buffer }> | undefined;
    if (attachmentPaths && attachmentPaths.length > 0) {
      loadedFiles = [];
      for (const filePath of attachmentPaths) {
        try {
          const data = await readFile(filePath);
          const filename = filePath.split("/").pop() ?? filePath;
          loadedFiles.push({ filename, data: Buffer.from(data) });
        } catch {
          return `Error: cannot read attachment at path "${filePath}"`;
        }
      }
    }

    await this.deliver(threadId, randomUUID(), content, loadedFiles);
    return "sent";
  };

  const tools = new Map<string, {
    toolDefinition: ToolDefinition;
    execute: (input: Record<string, unknown>) => Promise<string>;
  }>();
  tools.set("discord_send_message", { toolDefinition, execute });
  return tools;
}
```

Note: `randomUUID` is already imported at the top of `discord.ts` (`import { randomUUID } from "node:crypto"`). The `readFile` from `node:fs/promises` import is new.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 3)
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add `getConnector()` to `PlatformConnectorRegistry`

**Verifies:** platform-scoped-tools.AC4.1, platform-scoped-tools.AC4.2

**Files:**
- Modify: `packages/platforms/src/registry.ts` — add method to `PlatformConnectorRegistry`

**Implementation:**

The registry stores `PlatformLeaderElection` instances in `this.elections` keyed by platform name. Each election has a `.connector` property. Add `getConnector()` as a public method:

```typescript
/**
 * Look up a connector by platform name.
 * Returns the connector instance regardless of whether it is currently the leader.
 *
 * @param platform - Platform identifier, e.g. "discord"
 * @returns The connector instance, or `undefined` if not registered.
 */
getConnector(platform: string): PlatformConnector | undefined {
  return this.elections.get(platform)?.connector;
}
```

Place this method after `stop()`.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No errors

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Write tests for `getPlatformTools()` in `discord-connector.test.ts`

**Verifies:** platform-scoped-tools.AC1.1, platform-scoped-tools.AC1.2, platform-scoped-tools.AC1.3, platform-scoped-tools.AC1.4, platform-scoped-tools.AC1.5, platform-scoped-tools.AC1.6, platform-scoped-tools.AC2.1, platform-scoped-tools.AC2.2

AC mapping (design spec):
- AC1.1 = valid content under 2000 chars, no attachments → deliver called, returns "sent"
- AC1.2 = valid content + readable attachment → deliver called with typed buffer
- AC1.3 = multiple execute() calls → multiple separate deliver() invocations
- AC1.4 = content > 2000 chars → error string, deliver NOT called
- AC1.5 = unreadable attachment → error string, deliver NOT called
- AC1.6 = content exactly 2000 chars → succeeds

**Files:**
- Modify: `packages/platforms/src/__tests__/discord-connector.test.ts` — add test suite at bottom of file

**Context:** The existing test file already sets up `db`, `eventBus`, `mockLogger`, and `config`. Tests for `getPlatformTools()` need a real `DiscordConnector` instance but must mock `deliver()` to avoid Discord API calls. Use `jest.spyOn` equivalent — in bun:test, use `mock.module` or simply replace the method on the instance.

The test pattern: create a `DiscordConnector`, replace its `deliver` method with a spy, call `getPlatformTools(threadId).get("discord_send_message").execute(input)`, and assert on the spy calls and return value.

For attachment path tests, use a real temporary file (write via `writeFileSync`) so the path is genuinely readable. For the unreadable-path test, use a path that does not exist.

**Testing approach:**

```typescript
// At top of test file — add these imports if not already present:
// import { writeFileSync, unlinkSync } from "node:fs";
// import { tmpdir } from "node:os";
// import { join } from "node:path";

describe("DiscordConnector.getPlatformTools()", () => {
  it("returns map with discord_send_message tool definition (AC2.1)", async () => {
    // Create connector, call getPlatformTools, check map contains key with valid toolDefinition
    // Assert: map.has("discord_send_message") === true
    // Assert: toolDefinition.function.name === "discord_send_message"
    // Assert: toolDefinition.function.parameters.required includes "content"
  });

  it("execute closure is bound to the provided threadId (AC2.2)", async () => {
    // Create connector, spy on deliver(), call execute({ content: "hi" })
    // Assert: deliver was called with threadId matching the one passed to getPlatformTools
  });

  it("valid content under 2000 chars calls deliver() and returns 'sent' (AC1.1)", async () => {
    // Spy on deliver(), call execute({ content: "hello" })
    // Assert: deliver called once, returns "sent"
  });

  it("content exactly 2000 chars succeeds (AC1.6)", async () => {
    // Call execute({ content: "x".repeat(2000) })
    // Assert: returns "sent", deliver called
  });

  it("content over 2000 chars returns error, deliver not called (AC1.4)", async () => {
    // Call execute({ content: "x".repeat(2001) })
    // Assert: returns string starting with "Error", deliver NOT called
  });

  it("readable attachment path calls deliver() with loaded buffer and returns 'sent' (AC1.2)", async () => {
    // Write a temp file, call execute({ content: "hi", attachments: [tempPath] })
    // Assert: deliver called with attachments array containing { filename, data: Buffer }
    // Assert: returns "sent"
  });

  it("unreadable attachment path returns error, deliver not called (AC1.5)", async () => {
    // Call execute({ content: "hi", attachments: ["/no/such/file.txt"] })
    // Assert: returns string starting with "Error", deliver NOT called
  });

  it("multiple execute() calls each invoke deliver() separately (AC1.3)", async () => {
    // Call execute({ content: "msg1" }) then execute({ content: "msg2" })
    // Assert: deliver called twice total (2 separate invocations)
  });
});
```

Use `randomBytes(4).toString("hex")` for test IDs in any temp paths, consistent with the existing pattern in this test file.

**Verification:**
Run: `bun test packages/platforms`
Expected: All new tests pass, zero failures

**Commit:** (part of phase commit — see Task 5)
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Write tests for `getConnector()` in `registry.test.ts` and final commit

**Verifies:** platform-scoped-tools.AC4.1, platform-scoped-tools.AC4.2

**Files:**
- Modify: `packages/platforms/src/__tests__/registry.test.ts` — add test cases for `getConnector()`

**Testing approach:**

Add a new describe block to the existing `registry.test.ts`:

```typescript
describe("PlatformConnectorRegistry.getConnector()", () => {
  it("returns the registered connector for a known platform (AC4.1)", () => {
    // Start a registry with a WebhookStubConnector (platform="webhook-stub")
    // Call getConnector("webhook-stub")
    // Assert: returns an object (connector instance)
    // Assert: connector.platform === "webhook-stub"
  });

  it("returns undefined for an unknown platform (AC4.2)", () => {
    // Call getConnector("nonexistent")
    // Assert: returns undefined
  });
});
```

**Verification:**
Run: `bun test packages/platforms`
Expected: All tests pass

**Step 2: Commit everything**

```bash
git add packages/platforms/src/connectors/discord.ts \
        packages/platforms/src/registry.ts \
        packages/platforms/src/__tests__/discord-connector.test.ts \
        packages/platforms/src/__tests__/registry.test.ts
git commit -m "feat(platforms): implement discord_send_message tool and getConnector() registry lookup"
```
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->
