# Discord "File for Later" Implementation Plan — Phase 4

**Goal:** After writing the intake relay, poll the local DB for the agent's response and deliver it via the interaction's ephemeral channel.

**Architecture:** After the filing flow (Phase 3) writes the intake relay and emits `sync:trigger`, the agent loop processes the message and writes an assistant response to the messages table. The interaction handler polls the local DB at 500ms intervals (adapted from the `bound-mcp` polling pattern in `packages/mcp-server/src/handler.ts:24-43`) looking for an assistant message on the interaction's thread with `created_at` after the filed user message. On success, it calls `deliver()` which uses `editReply`. On timeout (5 minutes), it sends a timeout error via `editReply`. The polling queries the local DB directly (not HTTP) since the interaction connector runs on the platform leader host.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 5 phases from original design (phase 4 of 5)

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### discord-file-for-later.AC8: Response polling
- **discord-file-for-later.AC8.1 Success:** After intake relay, polling finds assistant response on the thread and delivers via `editReply`
- **discord-file-for-later.AC8.2 Failure:** No response within 5 minutes results in `editReply` with timeout error message

---

<!-- START_TASK_1 -->
### Task 1: Add response polling to handleInteraction

**Files:**
- Modify: `packages/platforms/src/connectors/discord-interaction.ts` (modified in Phase 3)

**Implementation:**

Add polling constants and a `pollForResponse()` method to DiscordInteractionConnector. Call it at the end of `handleInteraction()` after writing the intake relay.

**Add constants near top of file (after existing constants):**

```typescript
/** Polling interval for agent response. Matches bound-mcp pattern. */
const POLL_INTERVAL_MS = 500;

/** Maximum time to wait for agent response. */
const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
```

**Add a `disconnecting` flag field to the class (alongside existing fields):**

```typescript
/** Set by disconnect() to abort any active polling loops. */
private disconnecting = false;
```

**Reset the flag in `connect()` (at the start of the method):**

```typescript
this.disconnecting = false;
```

**Set the flag in `disconnect()` (at the start of the method, before clearing interactions):**

```typescript
this.disconnecting = true;
```

**Add polling method to the class:**

```typescript
/**
 * Poll the local DB for an assistant response on the thread.
 * Adapted from packages/mcp-server/src/handler.ts:24-43.
 *
 * Unlike bound-mcp which polls via HTTP, this queries the DB directly
 * since the interaction connector runs on the platform leader host.
 *
 * Checks this.disconnecting to abort early on shutdown.
 */
private async pollForResponse(threadId: string, afterTimestamp: string): Promise<void> {
    const startTime = Date.now();

    while (true) {
        // Abort if connector is shutting down
        if (this.disconnecting) {
            this.logger.info("Polling aborted — connector disconnecting", { threadId });
            this.interactions.delete(threadId);
            return;
        }
        // Query for assistant response created after the user's filing message
        const response = this.db
            .query<{ id: string; content: string }, [string, string]>(
                "SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND created_at > ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
            )
            .get(threadId, afterTimestamp);

        if (response) {
            // AC8.1: Found response — deliver via editReply
            await this.deliver(threadId, response.id, response.content);
            return;
        }

        // AC8.2: Check timeout
        if (Date.now() - startTime >= MAX_POLL_MS) {
            this.logger.warn("Polling timed out waiting for agent response", { threadId });
            // Deliver timeout error via editReply
            const stored = this.interactions.get(threadId);
            if (stored && new Date(stored.expiresAt) > new Date()) {
                try {
                    await stored.interaction.editReply({
                        content: "Error: Timed out waiting for agent response after 5 minutes.",
                    });
                } catch (err) {
                    this.logger.warn("editReply failed for timeout message", {
                        threadId,
                        error: String(err),
                    });
                }
            }
            this.interactions.delete(threadId);
            return;
        }

        // Wait before next poll (same pattern as bound-mcp handler.ts:42)
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}
```

**Update `handleInteraction()` — add polling call at the end:**

After the intake relay write and the `sync:trigger` emit (added in Phase 3), add the polling call. The `now` variable from Phase 3's message insert serves as the `afterTimestamp`:

```typescript
// ... (Phase 3 code: intake relay write + sync:trigger emit)

// Phase 4: Poll for agent response and deliver
// Use the user message's created_at as the "after" boundary
await this.pollForResponse(thread.id, now);
```

This goes at the end of `handleInteraction()`, replacing the Phase 3 log message. The complete flow is now: deferReply → validate → file → poll → deliver/timeout.

**Note on blocking:** The polling loop runs in the interaction handler's async context. Since each interaction creates its own handler invocation, concurrent "File for Later" interactions from different users poll independently. The 500ms sleep yields the event loop between polls.

**Note on shutdown:** The `disconnecting` flag is checked at the start of each poll iteration. When `disconnect()` sets this flag, active polling loops abort within one poll interval (500ms) rather than blocking shutdown for up to 5 minutes.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): add response polling to DiscordInteractionConnector`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Write response polling tests

**Verifies:** discord-file-for-later.AC8.1, discord-file-for-later.AC8.2

**Files:**
- Modify: `packages/platforms/src/__tests__/discord-interaction.test.ts` (modified in Phase 3)

**Testing:**

Add a new `describe("Response polling")` block. These tests exercise the full filing + polling flow, so they need a real SQLite database with the full schema applied.

The key testing challenge is simulating the agent's response appearing in the DB during polling. Two approaches:
1. **Pre-insert**: Insert the assistant message before calling the handler (response already exists)
2. **Delayed insert**: Use `setTimeout` to insert the assistant message after a delay (simulates agent latency)

Both approaches should be tested.

**AC test cases:**

- **AC8.1 (immediate response)**: Call `handleInteraction()` on a mock interaction. Before the handler runs, pre-insert an assistant message on the thread with `created_at` slightly after the expected user message timestamp. Verify `editReply` was called with the assistant message's content.

- **AC8.1 (delayed response)**: Call `handleInteraction()`. Use `setTimeout` (e.g., 600ms delay) to insert an assistant message into the DB on the interaction's thread. The polling loop should find it on the second or third poll. Verify `editReply` was called with the response content.

- **AC8.2 (timeout)**: To avoid waiting 5 real minutes, either:
  - Extract `MAX_POLL_MS` as a configurable parameter on the class (preferred for testability), OR
  - Mock `Date.now()` to fast-forward time

  The recommended approach: add an optional `pollTimeoutMs` parameter to the constructor (default `5 * 60 * 1000`). In tests, set it to a short value (e.g., 1000ms = 1 second). Call `handleInteraction()` without inserting any assistant message. Verify `editReply` was called with `"Error: Timed out waiting for agent response after 5 minutes."` after the timeout.

- **AC8.1 + AC6.2 (truncation via deliver)**: Insert an assistant response longer than 2000 characters. Verify `editReply` received content truncated to exactly 2000 chars (this exercises Phase 2's `deliver()` truncation through the polling flow).

**Important**: The filing flow (Phase 3) is a prerequisite — the handler creates the user, thread, and message before polling starts. These tests should verify the thread and user are created AND that polling finds the response.

For the `pollTimeoutMs` constructor parameter, add it to the constructor:
```typescript
constructor(
    config: PlatformConnectorConfig,
    db: Database,
    siteId: string,
    eventBus: TypedEventEmitter,
    logger: Logger,
    clientManager: DiscordClientManager,
    private readonly pollTimeoutMs: number = MAX_POLL_MS,
) {}
```

Then use `this.pollTimeoutMs` instead of `MAX_POLL_MS` in `pollForResponse()`.

Follow project testing patterns in:
- `packages/platforms/src/__tests__/discord-connector.test.ts` (real DB setup)
- `packages/agent/src/__tests__/helpers.ts` (`waitFor()` utility for polling conditions)
- Root `CLAUDE.md` lines 123-131 (testing conventions)

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-interaction.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): add response polling tests for DiscordInteractionConnector`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Verify full platform test suite

**Files:** None (verification only)

**Verification:**
Run: `bun test packages/platforms`
Expected: All platform tests pass

Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** No commit — verification only
<!-- END_TASK_3 -->
