# Human Test Plan: Discord "File for Later"

**Generated:** 2026-03-30
**Implementation plan:** `docs/implementation-plans/2026-03-30-discord-file-for-later/`
**Automated test coverage:** 27/27 acceptance criteria passing

## Prerequisites

- A dedicated Discord test server with the bot invited (with `applications.commands` scope)
- The bound service deployed with `platforms.json` containing a `{ "platform": "discord", "token": "...", "allowed_users": ["<your-discord-id>"] }` entry
- A second Discord user account (or incognito session) for visibility testing
- Automated tests passing: `bun test packages/platforms/src/__tests__/discord-interaction.test.ts packages/platforms/src/__tests__/registry.test.ts packages/platforms/src/__tests__/discord-client-manager.test.ts` (58 pass, 0 fail)
- Access to the bound web UI at `http://localhost:3000` or equivalent

## Phase 1: Context Menu Appearance

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | In the test Discord server, locate any message posted by another user. Right-click (desktop) or long-press (mobile) the message. | A context menu appears. |
| 1.2 | Look for the "Apps" submenu in the context menu. Click/tap "Apps". | An "Apps" submenu expands. |
| 1.3 | Locate "File for Later" in the apps list. | "File for Later" appears as an option. No duplicate entries exist. |
| 1.4 | Restart the bound service (or force a reconnect). Repeat steps 1.1-1.3. | "File for Later" still appears exactly once (idempotent upsert). |

## Phase 2: Ephemeral Interaction Flow

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | User A: Right-click a message with text content (e.g., "Remember this for later"). Select "Apps" then "File for Later". | A thinking/loading indicator appears briefly (deferReply). |
| 2.2 | Wait up to 30 seconds for the agent to respond. | An ephemeral response appears to User A containing the agent's filing confirmation. The response is visible only in User A's view (marked "Only you can see this"). |
| 2.3 | User B: Check the same channel at the same time. | User B sees NO bot response. No public message from the bot appears in the channel. |
| 2.4 | User A: Dismiss the ephemeral message (click "Dismiss message" or navigate away and return). | The ephemeral message disappears. No persistent trace of the interaction remains in the channel. |

## Phase 3: Authorization and Validation

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | User B (not in `allowed_users`): Right-click a message, select "File for Later". | An ephemeral error message appears: "Error: You are not authorized to use this command." |
| 3.2 | Open the bound web UI. Navigate to the threads list. | No thread was created for User B. No messages appear from User B. |
| 3.3 | User A: Right-click a message that contains ONLY an embed (no text, no image attachments). Select "File for Later". | An ephemeral error message appears: "Error: This message has no extractable content." |
| 3.4 | Open the bound web UI. Verify no new thread/message was created for step 3.3. | The threads list is unchanged from before step 3.3. |

## Phase 4: Filing Prompt Content

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | User A: File a message authored by User A themselves (a recognized bound user). | Open the bound web UI, navigate to the `discord-interaction` thread, check the user message. It should contain `(recognized -- bound user "<display_name>")` in the "From:" line. |
| 4.2 | User A: File a message authored by an unknown user (someone not in the bound allowlist). | The filing prompt in the web UI should contain `(unrecognized)` in the "From:" line. |
| 4.3 | User A: File a message authored by the bot itself. | The filing prompt should contain `(this bot)` in the "From:" line. |
| 4.4 | Verify the filing prompt includes channel name (e.g., `#general`), server name, and the original message timestamp. | All three metadata fields are present and correct in the persisted user message visible in the web UI. |

## Phase 5: Response Delivery and Truncation

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | User A: File a normal message. Wait for the agent to respond. | The ephemeral reply contains the agent's response text. It is coherent and references the filed content. |
| 5.2 | Verify in the web UI that the thread at `/api/threads` shows the assistant response as the most recent message. | The assistant message content matches what was shown in the ephemeral Discord reply. |
| 5.3 | (If possible) Trigger a scenario where the agent produces a response longer than 2000 characters. | The ephemeral reply in Discord is truncated to exactly 2000 characters. The full response is visible in the bound web UI. |

## End-to-End: Full Filing Lifecycle

**Purpose:** Validate the complete flow from context menu interaction through agent processing to ephemeral response delivery, spanning the interaction handler, message pipeline, intake relay, agent loop, and response polling.

**Steps:**
1. Ensure the bound service is running with relay/sync configured (or standalone mode).
2. In Discord, User A right-clicks a message from another user containing meaningful text content (e.g., a technical explanation or a link with description).
3. Select "Apps" then "File for Later".
4. Observe the ephemeral "thinking" state (deferReply).
5. Wait for the agent response (should appear within 30-60 seconds).
6. Verify the ephemeral reply contains a meaningful filing confirmation.
7. Open the bound web UI at `http://localhost:3000`.
8. Navigate to the threads list and find the `discord-interaction` thread.
9. Verify: (a) The user message contains the full filing prompt with metadata. (b) The assistant response matches the ephemeral Discord reply. (c) The thread's `interface` is `discord-interaction`.
10. Repeat step 2-6 with a second message from the same Discord user.
11. Verify in the web UI that the second filing reuses the same thread (no duplicate thread created).
12. Verify that the user record in the database has a single entry for this Discord user.

## End-to-End: Timeout Behavior (Optional)

**Purpose:** Validate that the 5-minute polling timeout produces a user-visible error when the agent fails to respond.

**Steps:**
1. Temporarily configure the agent to be unable to respond (e.g., stop the agent loop, or configure an unreachable model backend).
2. User A: File a message via "File for Later".
3. Wait for 5 minutes.
4. Verify the ephemeral reply shows: "Error: Timed out waiting for agent response after 5 minutes."
5. Restore normal agent configuration.

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC2.2 (partial) -- Ephemeral visibility | Discord's ephemeral message rendering cannot be tested programmatically. Automated tests verify `deferReply({ ephemeral: true })` is called, but only Discord's client renders the visibility constraint. | Deploy to test server. User A files a message. Verify User A sees the response marked "Only you can see this". Verify User B in the same channel sees NO bot response at all. |
| AC1.1 (partial) -- Context menu UI | Automated tests verify the `commands.create()` API call, but only Discord's client renders the context menu option. | Deploy to test server. Right-click any message. Verify "File for Later" appears under "Apps" submenu. Verify it has the correct icon/label. |
| AC7.4 (partial) -- Leader election failover | Automated tests verify compound lifecycle calls but cannot test real multi-host failover timing with actual Discord gateway connections. | In a two-host cluster: (1) Identify the current leader host. (2) Stop the leader host's bound service. (3) Wait for `failover_threshold_ms` (default 30s). (4) Verify the standby host claims leadership. (5) On the new leader, verify "File for Later" still works. |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `discord-interaction.test.ts` "should register 'File for Later' command on connect()" | Phase 1, steps 1.1-1.3 |
| AC1.2 | `discord-interaction.test.ts` "should call commands.create each time connect() is called" | Phase 1, step 1.4 |
| AC2.1 | `discord-interaction.test.ts` "should call deferReply({ ephemeral: true })" | Phase 2, step 2.1 |
| AC2.2 | `discord-interaction.test.ts` AC8.1 immediate/delayed tests | Phase 2, steps 2.2-2.4 |
| AC2.3 | `discord-interaction.test.ts` "AC2.3: allowlist rejection" | Phase 3, steps 3.1-3.2 |
| AC2.4 | `discord-interaction.test.ts` "AC2.4: empty content" | Phase 3, steps 3.3-3.4 |
| AC2.5 | `discord-interaction.test.ts` "Ignore non-matching interactions" (2 tests) | -- (not observable in Discord UI) |
| AC3.1 | `discord-interaction.test.ts` "AC3.1: user creation" | E2E step 12 |
| AC3.2 | `discord-interaction.test.ts` "AC3.2: thread creation" | E2E steps 10-11 |
| AC3.3 | `discord-interaction.test.ts` "AC3.3: message persistence" | Phase 4, steps 4.1-4.4 |
| AC3.4 | `discord-interaction.test.ts` "AC3.4: intake relay" | E2E steps 2-6 |
| AC4.1 | `discord-interaction.test.ts` "AC4.1: recognized user" | Phase 4, step 4.1 |
| AC4.2 | `discord-interaction.test.ts` "AC4.2: unrecognized user" | Phase 4, step 4.2 |
| AC4.3 | `discord-interaction.test.ts` "AC4.3: bot message" | Phase 4, step 4.3 |
| AC5.1 | `discord-client-manager.test.ts` "AC5.1: Client constructor" (2 tests) | -- (internal to Discord.js) |
| AC5.2 | `registry.test.ts` "should register both handlers on same client (AC5.2)" | -- (internal wiring) |
| AC5.3 | `registry.test.ts` "should disconnect with proper call sequence (AC5.3)" | -- (internal wiring) |
| AC6.1 | `discord-interaction.test.ts` "should call editReply on stored interaction" | Phase 5, step 5.1 |
| AC6.2 | `discord-interaction.test.ts` "should truncate content longer than 2000 chars" | Phase 5, step 5.3 |
| AC6.3 | `discord-interaction.test.ts` "should warn and not throw" (2 tests) | -- (internal error handling) |
| AC7.1 | `registry.test.ts` "should create both connectors (AC7.1)" | -- (verified via E2E steps 2-6) |
| AC7.2 | `registry.test.ts` "should route platform:deliver discord (AC7.2)" | -- (internal routing) |
| AC7.3 | `registry.test.ts` "should route platform:deliver discord-interaction (AC7.3)" | -- (internal routing) |
| AC7.4 | `registry.test.ts` "should share one leader election (AC7.4)" | Human Verification: leader failover |
| AC8.1 | `discord-interaction.test.ts` AC8.1 immediate + delayed tests | Phase 5, steps 5.1-5.2; E2E steps 5-9 |
| AC8.2 | `discord-interaction.test.ts` "AC8.2 (timeout)" | E2E Timeout scenario |
