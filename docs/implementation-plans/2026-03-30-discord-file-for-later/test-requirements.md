# Test Requirements: Discord "File for Later"

Generated from: docs/design-plans/2026-03-30-discord-file-for-later.md
Implementation plans: docs/implementation-plans/2026-03-30-discord-file-for-later/phase_01.md through phase_05.md

## Overview

This document maps each acceptance criterion sub-item from the Discord "File for Later" design to specific tests. Each AC is classified as automated (unit or integration test) or requiring human verification.

All automated test files live under `packages/platforms/src/__tests__/`.

---

## Automated Tests

### discord-file-for-later.AC1: Context menu command registration

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC1.1 | On `connect()`, "File for Later" command is registered globally via `client.application.commands.create()` with type `ApplicationCommandType.Message` (3) | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | After calling `connect()`, verify `client.application.commands.create()` was called with `{ name: "File for Later", type: 3 }`. Uses mock DiscordClientManager whose `getClient()` returns a mock client with a spy on `application.commands.create()`. |
| AC1.2 | Re-connecting does not duplicate the command (idempotent upsert) | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Call `connect()` twice. Verify `commands.create()` was called twice with identical arguments (Discord API handles server-side dedup; the test verifies the connector calls the upsert endpoint each time rather than accumulating duplicate registrations locally). |

### discord-file-for-later.AC2: Interaction handling and ephemeral response

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC2.1 | Selecting "File for Later" on a message triggers `deferReply({ ephemeral: true })` as first action | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire a mock `interactionCreate` event with `isMessageContextMenuCommand() = true` and `commandName = "File for Later"`. Verify `deferReply({ ephemeral: true })` was called. Verify it was called before any DB writes or `editReply` calls. |
| AC2.2 | Agent's real response delivered via `editReply`, visible only to the invoking user | integration | `packages/platforms/src/__tests__/discord-interaction.test.ts` | End-to-end test within the connector: fire interaction, insert an assistant response into the DB on the created thread, verify `editReply` is called with the assistant message content. The ephemeral visibility is guaranteed by AC2.1's `deferReply({ ephemeral: true })`; this test verifies the content delivery path. |
| AC2.3 | Interaction from non-allowlisted user receives ephemeral error reply, no message/thread/relay created | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Set `config.allowed_users = ["allowed-user"]`. Fire interaction with `user.id = "other-user"`. Verify `editReply` called with authorization error message. Verify zero rows in `users`, `threads`, `messages`, and `relay_outbox` tables. |
| AC2.4 | Target message with empty content and no image attachments receives `editReply` with `"Error: This message has no extractable content."`, no pipeline invoked | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire interaction with `targetMessage.content = ""` and `targetMessage.attachments` as an empty collection (`.some()` returns false). Verify `editReply` called with exact error string. Verify no rows created in `users`, `threads`, `messages`, or `relay_outbox`. |
| AC2.5 | Non-"File for Later" context menu interactions are ignored | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Two sub-cases: (a) fire interaction where `isMessageContextMenuCommand()` returns `false` -- verify `deferReply` was NOT called; (b) fire interaction where `isMessageContextMenuCommand()` returns `true` but `commandName = "Other Command"` -- verify `deferReply` was NOT called. |

### discord-file-for-later.AC3: Message pipeline reuse

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC3.1 | Interaction creates/reuses user record via `findOrCreateUser` with `interaction.user.id` | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire interaction. Query `users` table and verify a row exists with `json_extract(platform_ids, '$.discord') = interaction.user.id`. Fire a second interaction with the same `user.id`. Verify the same user row is reused (count remains 1, same `id`). |
| AC3.2 | Interaction creates/reuses thread with `interface = 'discord-interaction'` | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire interaction. Query `threads` table and verify a row exists with `interface = 'discord-interaction'` and the correct `user_id`. Fire a second interaction with the same user. Verify the same thread is reused (count remains 1). |
| AC3.3 | User message persisted via `insertRow("messages", ...)` with filing prompt containing target content, author, channel, timestamp | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire interaction with known content, author display name, channel name, guild name, and timestamp. Query `messages` table for `role = 'user'` on the created thread. Verify `content` matches the expected filing prompt format. Verify a corresponding `change_log` entry exists (proving `insertRow` was used). |
| AC3.4 | Intake relay written via `writeOutbox` with `platform: "discord-interaction"`, `sync:trigger` emitted | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire interaction. Query `relay_outbox` for `kind = 'intake'`. Parse `payload` JSON and verify `platform = "discord-interaction"`, and that `thread_id`, `user_id`, `message_id`, `content` fields are present and correct. Verify `eventBus.emit` was called with `"sync:trigger"` (use spy on the event bus). |

### discord-file-for-later.AC4: Target author trust signal

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC4.1 | Target author found in users table includes `(recognized -- bound user "name")` in prompt | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Pre-insert a user row with `platform_ids = '{"discord": "target-author-id"}'` and `display_name = "alice"`. Fire interaction with `targetMessage.author.id = "target-author-id"`. Query the persisted user message and verify the filing prompt contains the recognized trust signal string (em-dash variant). |
| AC4.2 | Target author not found includes `(unrecognized)` in prompt | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Fire interaction with a `targetMessage.author.id` that does not exist in the `users` table. Query the persisted user message and verify the filing prompt contains `(unrecognized)`. |
| AC4.3 | Target message from the bot itself includes `(this bot)` in prompt | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Configure mock client with `client.user = { id: "bot-id" }`. Fire interaction with `targetMessage.author.id = "bot-id"`. Query the persisted user message and verify the filing prompt contains `(this bot)`. |

### discord-file-for-later.AC5: DiscordClientManager

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC5.1 | Client created with combined intents: `DirectMessages`, `DirectMessageReactions`, `MessageContent`, `Guilds` | unit | `packages/platforms/src/__tests__/discord-client-manager.test.ts` | Mock `import("discord.js")` to capture the constructor options passed to `new Client(...)`. Call `connect()`. Verify the `intents` array contains all four `GatewayIntentBits` values and the `partials` array contains `Channel`, `Message`, `Reaction`. |
| AC5.2 | Both connectors register event handlers on the same client instance | integration | `packages/platforms/src/__tests__/registry.test.ts` | Create registry with a `{ platform: "discord" }` config. After the compound connector's `connect()` completes, verify the mock client's `on()` method was called with both `"messageCreate"` (from DiscordConnector) and `"interactionCreate"` (from DiscordInteractionConnector). |
| AC5.3 | `disconnect()` destroys client and both connectors' handlers are cleaned up | integration | `packages/platforms/src/__tests__/registry.test.ts` | Call the compound connector's `disconnect()`. Verify: (1) `client.off()` called for `"interactionCreate"`, (2) `client.off()` called for `"messageCreate"` and `"clientReady"`, (3) `client.destroy()` called last. |

### discord-file-for-later.AC6: Interaction connector deliver()

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC6.1 | `deliver()` with valid stored interaction calls `editReply` with content | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Call `storeInteraction(threadId, mockInteraction)` with a mock whose `editReply` is a spy. Call `deliver(threadId, msgId, "response text")`. Verify `mockInteraction.editReply({ content: "response text" })` was called exactly once. |
| AC6.2 | Content > 2000 chars truncated to 2000 chars before `editReply` | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Store a mock interaction. Call `deliver()` with a 2500-character string. Verify `editReply` received content of exactly 2000 characters. |
| AC6.3 | Interaction token expired or missing logs warning, does not throw | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Two sub-cases: (a) `deliver()` with no stored interaction -- verify no throw, `logger.warn` called; (b) stored interaction with `expiresAt` in the past -- verify no throw, `logger.warn` called about expired token. |

### discord-file-for-later.AC7: Registry integration

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC7.1 | Single `{ "platform": "discord" }` config entry creates both connectors | integration | `packages/platforms/src/__tests__/registry.test.ts` | Create registry with single Discord config. Verify `getConnector("discord")` returns a DiscordConnector instance. Verify `getConnector("discord-interaction")` returns a DiscordInteractionConnector instance. Verify both are non-null and different objects. |
| AC7.2 | `platform:deliver` for `"discord"` routes to `DiscordConnector.deliver()` | integration | `packages/platforms/src/__tests__/registry.test.ts` | Emit `platform:deliver` with `platform = "discord"`. Verify only DiscordConnector's `deliver()` was called. |
| AC7.3 | `platform:deliver` for `"discord-interaction"` routes to `DiscordInteractionConnector.deliver()` | integration | `packages/platforms/src/__tests__/registry.test.ts` | Emit `platform:deliver` with `platform = "discord-interaction"`. Verify only DiscordInteractionConnector's `deliver()` was called. |
| AC7.4 | Both connectors share one `PlatformLeaderElection` and connect/disconnect together | integration | `packages/platforms/src/__tests__/registry.test.ts` | Verify one election in `elections` map. Verify compound connect calls: `clientManager.connect()`, `dmConnector.connect()`, `interactionConnector.connect()`. Verify reverse disconnect: `interactionConnector.disconnect()`, `dmConnector.disconnect()`, `clientManager.disconnect()`. |

### discord-file-for-later.AC8: Response polling

| AC | Text | Type | Test File | Description |
|----|------|------|-----------|-------------|
| AC8.1 | After intake relay, polling finds assistant response and delivers via `editReply` | integration | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Two sub-cases: (a) immediate response (pre-insert assistant message); (b) delayed response (insert via setTimeout ~600ms). Both verify `editReply` called with correct content. |
| AC8.2 | No response within 5 minutes results in `editReply` with timeout error | unit | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Use short `pollTimeoutMs` override (1000ms). Fire interaction without inserting response. Verify `editReply` called with timeout error message. |

---

## Test File Summary

| Test File | ACs Covered | Phase |
|-----------|-------------|-------|
| `packages/platforms/src/__tests__/discord-client-manager.test.ts` | AC5.1 | Phase 1 |
| `packages/platforms/src/__tests__/discord-interaction.test.ts` | AC1.1, AC1.2, AC2.1-AC2.5, AC3.1-AC3.4, AC4.1-AC4.3, AC6.1-AC6.3, AC8.1, AC8.2 | Phases 2-4 |
| `packages/platforms/src/__tests__/registry.test.ts` | AC5.2, AC5.3, AC7.1-AC7.4 | Phase 5 |
| `packages/platforms/src/__tests__/discord-connector.test.ts` | (existing tests, updated for new constructor) | Phase 1 |
| `packages/platforms/src/__tests__/discord-attachment.test.ts` | (existing tests, updated for new constructor) | Phase 1 |

---

## Human Verification

| AC | Text | Justification | Verification Approach |
|----|------|---------------|----------------------|
| AC2.2 (partial) | Agent's real response visible **only** to the invoking user | Ephemeral visibility is enforced by Discord's system via `deferReply({ ephemeral: true })`. Cannot verify Discord UI rendering in automated tests. | Deploy to test Discord server. User A selects "File for Later". Verify User A sees the response. Verify User B in the same channel does NOT see any bot response. |
| AC1.1 (partial) | Command appears in Discord's context menu UI | Automated tests verify the API call but cannot verify Discord renders the option. | Deploy to test Discord server. Right-click any message. Verify "File for Later" appears in the "Apps" submenu. |
| AC7.4 (partial) | Leader election failover with real multi-host timing | Automated tests verify compound lifecycle calls but not real election failover. | In a two-host cluster, stop the leader host. Verify the standby host claims leadership and both connectors reconnect on the new leader. |

---

## Notes

1. **Mock strategy**: Tests mock `DiscordClientManager` rather than discord.js directly, except for `discord-client-manager.test.ts` which mocks the dynamic `import("discord.js")` call.

2. **Real SQLite databases**: Tests for AC2.3, AC2.4, AC3.x, AC4.x, AC7.x, AC8.x require real SQLite test databases with `applySchema(db)` + `randomBytes(4).toString("hex")` temp path pattern.

3. **Polling timeout testability**: AC8.2 uses `pollTimeoutMs` constructor override (Phase 4) to avoid 5-minute test runs.

4. **Trust signal character**: Uses em-dash (`---`) matching the design's Architecture section format.
