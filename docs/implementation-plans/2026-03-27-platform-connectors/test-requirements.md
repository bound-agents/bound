# Test Requirements: platform-connectors

This document maps every acceptance criterion from `docs/design-plans/2026-03-27-platform-connectors.md` to either an automated test or a documented human verification step. Test file paths and types are rationalized against the implementation phases.

---

## AC1: Schema migrations applied correctly

### platform-connectors.AC1.1
- **Type:** unit
- **Phase:** 1 (Task 7)
- **File:** `packages/core/src/__tests__/schema.test.ts`
- **Description:** After `applySchema()` on a fresh in-memory DB, `PRAGMA table_info(users)` contains a `platform_ids` column of type `TEXT`.

### platform-connectors.AC1.2
- **Type:** unit
- **Phase:** 1 (Task 7)
- **File:** `packages/core/src/__tests__/schema.test.ts`
- **Description:** Create a DB with the old schema containing a `users` row with `discord_id = '12345'`. Run `applySchema()`. Assert the row's `platform_ids` equals `'{"discord":"12345"}'`.

### platform-connectors.AC1.3
- **Type:** unit
- **Phase:** 1 (Task 7)
- **File:** `packages/core/src/__tests__/schema.test.ts`
- **Description:** After `applySchema()`, `PRAGMA table_info(users)` does NOT contain a column named `discord_id`.

### platform-connectors.AC1.4
- **Type:** unit
- **Phase:** 1 (Task 7)
- **File:** `packages/core/src/__tests__/schema.test.ts`
- **Description:** After `applySchema()`, `PRAGMA table_info(hosts)` contains a `platforms` column of type `TEXT`.

### platform-connectors.AC1.5
- **Type:** unit
- **Phase:** 1 (Task 7)
- **File:** `packages/core/src/__tests__/schema.test.ts`
- **Description:** After `applySchema()`, inserting a row into `threads` with `interface = 'telegram'` succeeds without error. The stored value is retrievable and equals `'telegram'`.

### platform-connectors.AC1.6
- **Type:** unit
- **Phase:** 1 (Task 8)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Parsing `{ display_name: "Alice", discord_id: "12345" }` through `userEntrySchema.safeParse()` returns `success: false` with at least one issue message containing the string `"platforms.discord"`.

### platform-connectors.AC1.7
- **Type:** unit
- **Phase:** 1 (Task 8)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Parsing `{ display_name: "Alice", platforms: { discord: "12345" } }` through `userEntrySchema.safeParse()` returns `success: true`.

---

## AC2: Config schema and loader

### platform-connectors.AC2.1
- **Type:** unit
- **Phase:** 1 (Task 8), validated at runtime in Phase 6 (Task 4)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Parsing `{ connectors: [{ platform: "discord", token: "Bot.MyToken", leadership: "auto" }] }` through `platformsSchema.safeParse()` returns `success: true`.

### platform-connectors.AC2.2
- **Type:** unit
- **Phase:** 1 (Task 8)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Parsing `{ connectors: [{ platform: "discord", token: "Bot.MyToken", leadership: "manual" }] }` through `platformsSchema.safeParse()` returns `success: false` (invalid enum value).

### platform-connectors.AC2.3
- **Type:** unit
- **Phase:** 1 (Task 8)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Assert `"discord.json" in configSchemaMap` is `false`. The key `"platforms.json"` should be present instead.

### platform-connectors.AC2.4
- **Type:** unit
- **Phase:** 1 (Task 8)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Dynamically import `../config-schemas` and assert that `"discordSchema"` is not a key of the module exports. This confirms the old Discord schema is fully removed from the public API surface.

---

## AC3: Relay kind handlers (intake, platform_deliver, event_broadcast)

### platform-connectors.AC3.1
- **Type:** unit
- **Phase:** 1 (Task 8)
- **File:** `packages/shared/src/__tests__/config-schemas.test.ts`
- **Description:** Assert `RELAY_REQUEST_KINDS` array contains `"intake"`, `"platform_deliver"`, and `"event_broadcast"`. Three separate assertions, one per kind.

### platform-connectors.AC3.2
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Insert two `intake` inbox entries with the same `platform` + `platform_event_id` values. Process both through `RelayProcessor`. Assert `relay_outbox` contains exactly one `process` entry (the duplicate was discarded by the idempotency cache).

### platform-connectors.AC3.3
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Create two hosts in the `hosts` table. Set `threadAffinityMap.set(threadId, hostA.site_id)`. Process an `intake` entry for that thread. Assert the resulting `process` relay in `relay_outbox` has `target_site_id = hostA.site_id`.

### platform-connectors.AC3.3 (integration)
- **Type:** integration
- **Phase:** 7 (Task 1)
- **File:** `packages/platforms/src/__tests__/intake-pipeline.integration.test.ts`
- **Description:** Two-instance test (hub + spoke). Spoke writes an `intake` relay. Hub routes via thread affinity to the spoke. Spoke's `RelayProcessor` receives and processes the `process` relay. Validates the full pipeline with real sync cycles.

### platform-connectors.AC3.4
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Two hosts: hostA with `models: '["gpt-4"]'`, hostB with `models: '["claude-3"]'`. Insert a `turns` row for the thread with `model_id = "claude-3"`. No thread affinity. Process `intake`. Assert the `process` relay targets hostB.

### platform-connectors.AC3.5
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Two hosts: hostA with `mcp_tools: '["bash","files"]'`, hostB with `mcp_tools: '["bash","web","files"]'`. Thread has `messages` rows with `role = 'tool'` and `tool_name` values `"bash"`, `"web"`, `"files"`. No turns/model match, no affinity. Process `intake`. Assert `process` targets hostB (score 3 vs 2).

### platform-connectors.AC3.6
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Two hosts with no affinity, no turns, no mcp_tools. Seed `relay_outbox` with 3 pending (undelivered) entries targeting hostA and 1 targeting hostB. Process `intake`. Assert `process` targets hostB (least-loaded).

### platform-connectors.AC3.7
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Insert a `platform_deliver` inbox entry with a `PlatformDeliverPayload`. Listen for `"platform:deliver"` on the `eventBus`. Process the entry. Assert the event was emitted with the correct `platform`, `thread_id`, `message_id`, and `content`.

### platform-connectors.AC3.7 (integration)
- **Type:** integration
- **Phase:** 7 (Task 1)
- **File:** `packages/platforms/src/__tests__/intake-pipeline.integration.test.ts`
- **Description:** Full intake pipeline flow ending with `platform_deliver` relay delivery and `"platform:deliver"` eventBus emission on the spoke.

### platform-connectors.AC3.8
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Insert an `event_broadcast` inbox entry with `event_name: "task:triggered"`, `event_payload: { task_id: "t1", trigger: "test" }`, `event_depth: 2`. Listen for `"task:triggered"` on eventBus. Process the entry. Assert the event was emitted. Assert the emitted payload contains `__relay_event_depth = 2` and does NOT contain `event_depth` (stripped before scheduler sees it).

### platform-connectors.AC3.9
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/sync/src/__tests__/multi-instance.integration.test.ts`
- **Description:** Two spoke site IDs in keyring. POST a sync relay request from spokeA with an entry having `target_site_id = "*"`. Assert `relay_inbox` has one entry targeting spokeB but none targeting spokeA (echo-suppressed). Total new inbox rows equals number of spokes minus source.

### platform-connectors.AC3.9 (integration)
- **Type:** integration
- **Phase:** 7 (Task 4)
- **File:** `packages/sync/src/__tests__/multi-instance.integration.test.ts`
- **Description:** Extended multi-instance test. Spoke writes `event_broadcast` with `target_site_id = "*"`. After a full sync cycle, verify the hub received the broadcast entry and fan-out occurred to other spokes.

---

## AC4: emit command cross-host broadcast

### platform-connectors.AC4.1
- **Type:** unit
- **Phase:** 4 (Task 4)
- **File:** `packages/agent/src/__tests__/emit.test.ts`
- **Description:** Seed `cluster_config` with `key = 'cluster_hub'`, `value = 'hub-site-id'`. Call the `emit` command handler with `args = { event: "task:triggered", payload: '{"task_id":"t1","trigger":"test"}' }`. Assert `relay_outbox` has exactly one row with `kind = 'event_broadcast'`, `target_site_id = '*'`, and payload containing `event_name = 'task:triggered'`.

### platform-connectors.AC4.2
- **Type:** unit
- **Phase:** 4 (Task 4)
- **File:** `packages/agent/src/__tests__/emit.test.ts`
- **Description:** Ensure `cluster_config` has no `cluster_hub` entry. Call the `emit` command handler. Assert `relay_outbox` has zero rows with `kind = 'event_broadcast'`. Assert the local `eventBus.emit()` was still called (local emission is unaffected).

### platform-connectors.AC4.3
- **Type:** integration
- **Phase:** 7 (Task 2)
- **File:** `packages/sync/src/__tests__/event-broadcast.integration.test.ts`
- **Description:** Three-instance test (hub + spokeA + spokeB). SpokeB has an event-driven task with `trigger_type = "event"` and `trigger_value = "test:custom-event"`. SpokeA writes an `event_broadcast` relay. After sync cycles, spokeB's `RelayProcessor` fires the event on its local eventBus. The `Scheduler` picks up the matching task. Assert the task status transitions to `"claimed"`, `"running"`, or `"completed"`.

### platform-connectors.AC4.4
- **Type:** unit
- **Phase:** 2 (Task 3)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Insert an `event_broadcast` inbox entry with `event_depth: 1`. Process it. Assert the emitted event payload contains `__relay_event_depth = 1`, confirming depth is preserved through the relay processor without modification (incrementing happens in the `emit` command, not the processor).

---

## AC5: platforms package -- leader election and registry

### platform-connectors.AC5.1
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/leader-election.test.ts`
- **Description:** Create a `PlatformLeaderElection` with a mock connector and no pre-existing `cluster_config` entry for `platform_leader:discord`. Call `election.start()`. Assert `election.isLeader()` is `true` and `mockConnector.connect()` was called exactly once.

### platform-connectors.AC5.2
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/leader-election.test.ts`
- **Description:** Pre-insert a `cluster_config` row with `key = 'platform_leader:discord'` and `value = 'other-host-site-id'`. Also insert a `hosts` row for `other-host-site-id` with a recent `modified_at`. Call `election.start()`. Assert `election.isLeader()` is `false` and `mockConnector.connect()` was NOT called.

### platform-connectors.AC5.3
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/leader-election.test.ts`
- **Description:** Pre-insert a stale `cluster_config` leader pointing to `other-host`, and a `hosts` row for `other-host` with `modified_at` set to 10 minutes ago. Use a short `failover_threshold_ms` (e.g., 50ms). Call `election.start()`. Wait for `failover_threshold_ms * 2` (100ms+). Assert `election.isLeader()` becomes `true` and `mockConnector.connect()` was called.

### platform-connectors.AC5.4
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/leader-election.test.ts`
- **Description:** Call `election.start()` so this host claims leadership. Record initial `hosts.modified_at` for this siteId. Wait for at least one heartbeat interval (`failover_threshold_ms / 3 + margin`). Assert `hosts.modified_at` has changed (heartbeat was written).

### platform-connectors.AC5.5
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/registry.test.ts`
- **Description:** Create a `PlatformConnectorRegistry` with a connector config for `platform: "webhook-stub"`. Call `registry.start()`. Emit `"platform:deliver"` on eventBus with `platform: "webhook-stub"`. Assert the `WebhookStubConnector.deliver()` was called (it throws, which is caught and logged). Alternatively, test with a mock connector that tracks `deliver()` calls.

### platform-connectors.AC5.6
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/registry.test.ts`
- **Description:** Instantiate `WebhookStubConnector`. Assert `connector.delivery === "exclusive"`.

### platform-connectors.AC5.7
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/registry.test.ts`
- **Description:** Instantiate `WebhookStubConnector`. Call `connector.deliver(...)`. Assert it throws an error with message containing `"not implemented"` or `"stub only"`.

---

## AC6: Discord connector migrated

### platform-connectors.AC6.1
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/discord-connector.test.ts`
- **Description:** Call `DiscordConnector.onMessage(mockMsg)` with a mock Discord message object. Assert `relay_outbox` has a new row with `kind = 'intake'` and the payload contains `platform = "discord"` and `platform_event_id` matching the mock message ID. No agent loop should have been invoked.

### platform-connectors.AC6.2
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/discord-connector.test.ts`
- **Description:** Call `DiscordConnector.onMessage(mockMsg)`. Assert `messages` table has a new row with `role = 'user'`, `content` matching the mock message content, and a valid `id` (UUID). The row must have been persisted via `insertRow` (change_log entry exists).

### platform-connectors.AC6.3
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/discord-connector.test.ts`
- **Description:** Seed the DB with a thread and user (with `platform_ids = '{"discord":"user123"}'`). Mock the Discord client's `users.fetch()` to return an object whose `createDM()` returns a channel mock with a spy on `send()`. Call `connector.deliver(threadId, msgId, content)` where `content` is 3001 characters. Assert the mock channel's `send()` was called twice (first chunk: chars 0-1999, second chunk: chars 2000-3000).

### platform-connectors.AC6.4
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/discord-connector.test.ts`
- **Description:** Structural assertion: `expect("shouldActivate" in new DiscordConnector(...)).toBe(false)`. The old hostname-based activation check must not exist on the new connector class.

### platform-connectors.AC6.5
- **Type:** unit
- **Phase:** 3 (Task 6)
- **File:** `packages/platforms/src/__tests__/discord-connector.test.ts`
- **Description:** Create connector with `config.allowed_users = ["allowed123"]`. Call `onMessage` with `msg.author.id = "other456"`. Assert no new row in `messages` table and no new row in `relay_outbox` (message was silently rejected by the allowlist check).

---

## AC7: discord package deleted + webhook route

### platform-connectors.AC7.1
- **Type:** unit
- **Phase:** 6 (Task 7)
- **File:** `packages/core/src/__tests__/schema.test.ts` (or inline verification script)
- **Description:** After Phase 6 completes, assert that `packages/discord/` directory does not exist. This is verified by `ls packages/ | grep discord` returning empty output during Phase 6 Task 7.

**Note:** This is primarily a filesystem assertion. It can be automated as a shell check in CI or as a test that uses `fs.existsSync`. See Human Verification section for the rationale on supplementary manual verification.

### platform-connectors.AC7.2
- **Type:** integration
- **Phase:** 6 (Task 7)
- **File:** (CI / build verification)
- **Description:** `bun run build` succeeds with exit code 0. `grep -r "@bound/discord" dist/` returns no matches. This is verified during Phase 6 Task 7 as a build-level assertion.

**Note:** This is a build-level check, not a traditional unit test. It can be automated in CI as a post-build grep assertion. See Human Verification section.

### platform-connectors.AC7.3
- **Type:** unit
- **Phase:** 4 (Task 4)
- **File:** `packages/web/src/__tests__/webhooks.test.ts`
- **Description:** Create the webhook Hono app via `createWebhookRoutes(eventBus)`. Send a `POST /discord` request with a JSON body. Assert response status is 200. Assert `"platform:webhook"` was emitted on eventBus with `platform = "discord"` and `rawBody` containing the request body string.

---

## AC8: AbortSignal wiring in LLM drivers

### platform-connectors.AC8.1
- **Type:** unit
- **Phase:** 5 (Task 7)
- **File:** `packages/llm/src/__tests__/anthropic-driver.test.ts`
- **Description:** Create an `AbortController`. Mock `global.fetch` to return a never-ending streaming response and register an `abort` event listener on `options.signal`. Start consuming the chat stream with `signal: controller.signal`. Abort after 10ms. Assert the abort listener was triggered (signal was forwarded to fetch) and the async generator terminates (does not hang).

### platform-connectors.AC8.2
- **Type:** unit
- **Phase:** 5 (Task 7)
- **File:** `packages/llm/src/__tests__/bedrock-driver.test.ts`
- **Description:** Create an `AbortController`. Mock the `BedrockRuntimeClient.send()` method to capture the `options.abortSignal` parameter. Call `driver.chat({ ..., signal: controller.signal })`. Assert the captured `abortSignal` is the same reference as `controller.signal`.

### platform-connectors.AC8.3
- **Type:** unit
- **Phase:** 5 (Task 7)
- **File:** `packages/llm/src/__tests__/openai-driver.test.ts`
- **Description:** Same pattern as AC8.1. Mock `global.fetch` to detect the signal. Start stream with `signal: controller.signal`. Abort mid-stream. Assert abort was detected and generator terminates.

### platform-connectors.AC8.4
- **Type:** unit
- **Phase:** 5 (Task 7)
- **File:** `packages/llm/src/__tests__/ollama-driver.test.ts`
- **Description:** Same pattern as AC8.1. Mock `global.fetch` (MUST save/restore `global.fetch` in `afterAll` to avoid polluting other tests). Start stream with signal. Abort mid-stream. Assert abort detected and generator terminates.

### platform-connectors.AC8.5
- **Type:** unit
- **Phase:** 5 (Task 7)
- **File:** `packages/agent/src/__tests__/relay-processor.test.ts`
- **Description:** Use the existing `MockLLMBackend` to spy on `chat()` parameters. Trigger an inference relay execution through `RelayProcessor`. Assert the `chat()` call received a `signal` property that is an `AbortSignal` instance (from the internal `abortController`).

---

## Human Verification Required

### platform-connectors.AC7.1 -- `packages/discord/` directory does not exist
- **Justification:** This is a filesystem state assertion, not a behavioral test. While it can be partially automated with `fs.existsSync()` in a test, the definitive verification is that `rm -rf packages/discord` was executed and `bun install` / `bun run build` succeed without it. The Phase 6 Task 7 verification steps cover this with explicit shell commands.
- **Verification approach:** During Phase 6 execution, run `ls packages/ | grep discord` and confirm no output. Confirm `bun test --recursive` does not attempt to run any tests from `packages/discord/`. Confirm `bun run typecheck` passes with no `@bound/discord` resolution errors.

### platform-connectors.AC7.2 -- `bun run build` succeeds with no `@bound/discord` references
- **Justification:** Build success is a system-level property that depends on the entire compilation toolchain, not an isolated unit behavior. A unit test cannot meaningfully assert build success -- it requires running the actual build command and inspecting its output.
- **Verification approach:** During Phase 6 execution, run `bun run build` and confirm exit code 0. Run `grep -rn "@bound/discord" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v packages/platforms/src/connectors/discord` and confirm no output. The only remaining "discord" string references should be inside `packages/platforms/src/connectors/discord.ts` (the migrated connector).

### platform-connectors.AC4.3 -- Remote scheduler fires event-driven task (partial)
- **Justification:** The Phase 7 integration test (event-broadcast.integration.test.ts) validates the relay delivery and eventBus emission path. However, the full end-to-end flow (scheduler claims a task, agent loop runs, task completes) depends on the `Scheduler` and `AgentLoop` components working together with a `MockLLMBackend`, which introduces timing sensitivity in multi-instance tests. The automated test asserts task status transition but may require manual verification if timing-dependent failures occur.
- **Verification approach:** Run `bun test packages/sync/src/__tests__/event-broadcast.integration.test.ts` and confirm the AC4.3 test passes. If the test is flaky due to timing, increase the wait duration and re-run. As a fallback, manually start two bound instances, configure an event-driven task on one, run `emit` on the other, and verify the task executes.

---

## Test File Summary

| File | Package | Type | ACs Covered |
|---|---|---|---|
| `packages/core/src/__tests__/schema.test.ts` | core | unit | AC1.1, AC1.2, AC1.3, AC1.4, AC1.5 |
| `packages/shared/src/__tests__/config-schemas.test.ts` | shared | unit | AC1.6, AC1.7, AC2.1, AC2.2, AC2.3, AC2.4, AC3.1 |
| `packages/agent/src/__tests__/relay-processor.test.ts` | agent | unit | AC3.2, AC3.3, AC3.4, AC3.5, AC3.6, AC3.7, AC3.8, AC4.4, AC8.5 |
| `packages/sync/src/__tests__/multi-instance.integration.test.ts` | sync | integration | AC3.9 |
| `packages/platforms/src/__tests__/leader-election.test.ts` | platforms | unit | AC5.1, AC5.2, AC5.3, AC5.4 |
| `packages/platforms/src/__tests__/registry.test.ts` | platforms | unit | AC5.5, AC5.6, AC5.7 |
| `packages/platforms/src/__tests__/discord-connector.test.ts` | platforms | unit | AC6.1, AC6.2, AC6.3, AC6.4, AC6.5 |
| `packages/agent/src/__tests__/emit.test.ts` | agent | unit | AC4.1, AC4.2 |
| `packages/web/src/__tests__/webhooks.test.ts` | web | unit | AC7.3 |
| `packages/llm/src/__tests__/anthropic-driver.test.ts` | llm | unit | AC8.1 |
| `packages/llm/src/__tests__/bedrock-driver.test.ts` | llm | unit | AC8.2 |
| `packages/llm/src/__tests__/openai-driver.test.ts` | llm | unit | AC8.3 |
| `packages/llm/src/__tests__/ollama-driver.test.ts` | llm | unit | AC8.4 |
| `packages/platforms/src/__tests__/intake-pipeline.integration.test.ts` | platforms | integration | AC3.3, AC3.7 |
| `packages/sync/src/__tests__/event-broadcast.integration.test.ts` | sync | integration | AC4.3 |

---

## Phase-to-AC Mapping

| Phase | ACs Tested |
|---|---|
| Phase 1 | AC1.1-1.7, AC2.1-2.4, AC3.1 |
| Phase 2 | AC3.2-3.9, AC4.4 |
| Phase 3 | AC5.1-5.7, AC6.1-6.5 |
| Phase 4 | AC4.1, AC4.2, AC7.3 |
| Phase 5 | AC8.1-8.5 |
| Phase 6 | AC7.1, AC7.2 (human + CI verification) |
| Phase 7 | AC3.3 (integration), AC3.7 (integration), AC3.9 (integration), AC4.3 |
