# MCP Platform Connectors -- Test Requirements

Maps each acceptance criterion from `docs/design-plans/2026-05-08-mcp-platform-connectors.md` to specific tests with classification, file paths, and verification descriptions.

Testing conventions: `bun:test` runner, real temp SQLite databases (no mocking DB layer), `InMemoryTransport` for MCP client/server tests, mock Discord.js client for gateway interactions.

---

## AC1: Platform events arrive as MCP Events and persist correctly

### mcp-platform-connectors.AC1.1

**Criterion:** Discord DM received -> MCP server emits `notifications/events/event` with correct eventId, name, timestamp, data, cursor.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Create Discord MCP server via `createDiscordServer(config)` with mocked Discord.js client. Connect via InMemoryTransport pair. Subscribe to `message.received` via `events/stream`. Simulate a Discord `messageCreate` event from an allowlisted user. Assert the client receives a `notifications/events/event` notification with: non-empty `eventId` (Discord message ID), `name === "message.received"`, valid ISO 8601 `timestamp`, `data` containing `{ author, channel_id, content, message_id }`, and monotonically increasing `cursor`.

---

### mcp-platform-connectors.AC1.2

**Criterion:** Event persisted as `role: "developer"` message in the correct event task thread via outbox.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Set up PlatformMcpRegistry with test stub MCP server and real temp DB. Create a connector handle bound to a task with a thread. Emit an event from the server. Assert that a row appears in the `messages` table with: `role = "developer"`, `thread_id` matching the event task's thread, and `content` containing the serialized event batch data. Also verify a `change_log` entry exists for the message row (outbox pattern).

---

### mcp-platform-connectors.AC1.3

**Criterion:** Duplicate event (same eventId) is not persisted twice.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Emit the same event (identical eventId) from the MCP server twice. Assert that only one `role: "developer"` message is persisted in the task thread. The deduplication set in the active subscription filters the second occurrence before it reaches `deliverBatch()`.

---

### mcp-platform-connectors.AC1.4

**Criterion:** Bot's own messages are never emitted as events.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Simulate a Discord `messageCreate` event where `msg.author.bot === true`. Assert that no `notifications/events/event` notification is emitted to any subscriber. Verify by checking the notification handler is never called (or using a spy with zero invocations).

---

### mcp-platform-connectors.AC1.5

**Criterion:** Messages from non-allowlisted users are never emitted as events.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Configure `createDiscordServer` with `allowed_users: ["user-A"]`. Simulate a message from `user-B` (not in allowlist). Assert no event emitted. Then simulate a message from `user-A`. Assert event is emitted. Also test the empty-allowlist case (all users allowed): simulate from any user and assert event emitted.

---

### mcp-platform-connectors.AC1.6

**Criterion:** Attachments < 1MB included as base64 ContentBlocks in event data.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Mock `fetch` to return a 500KB PNG buffer for the attachment URL. Simulate a message with one attachment (`size: 500000`, `contentType: "image/png"`). Assert the event's `data.attachments` contains a ContentBlock with `{ type: "image", source: { type: "base64", media_type: "image/png", data: "<base64-string>" } }`. Verify the base64 string decodes to the original buffer.

---

### mcp-platform-connectors.AC1.7

**Criterion:** Attachments >= 1MB stored as file_ref in event data.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Simulate a message with one attachment (`size: 2000000`). Assert the event's `data.attachments` contains a ContentBlock with `{ type: "file_ref", file_id: "<attachment.id>", filename: "<attachment.name>", size: 2000000 }`. Verify no base64 data is present (no large download attempted for the test -- the server should check size before downloading).

---

## AC2: Agent uses MCP tools for outbound platform actions

### mcp-platform-connectors.AC2.1

**Criterion:** `discord_send_message` sends content to correct Discord channel.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Connect to Discord MCP server via InMemoryTransport. Call `tools/call` with `{ name: "discord_send_message", arguments: { channel_id: "123", content: "hello" } }`. Assert the mock Discord channel's `send()` method was called with `"hello"`. Assert the tool result contains `{ content: [{ type: "text", text: "sent" }] }`.

---

### mcp-platform-connectors.AC2.2

**Criterion:** Messages > 2000 chars are chunked at appropriate boundaries.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Call `discord_send_message` with a 5000-character message containing paragraph breaks (`\n\n`). Assert `channel.send()` was called multiple times (at least 3). Assert no individual chunk exceeds 2000 characters. Assert chunks split at paragraph boundaries (not mid-word). Test edge case: a single 2001-char paragraph with no natural break points splits at a space or, as last resort, at exactly 2000 chars.

---

### mcp-platform-connectors.AC2.3

**Criterion:** Typing indicator starts and stops within `discord_send_message` execution.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Call `discord_send_message` and record the order of Discord API calls on the mock channel. Assert `channel.sendTyping()` is called BEFORE `channel.send()`. Discord auto-stops typing on message send, so no explicit stop is needed -- verify the ordering only.

---

### mcp-platform-connectors.AC2.4

**Criterion:** `discord_respond_interaction` edits ephemeral reply for valid callback_id.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Inject a mock interaction into the server's interaction store (simulating an `interactionCreate` event) with a valid callback_id and recent timestamp. Call `tools/call` with `{ name: "discord_respond_interaction", arguments: { callback_id: "valid-id", content: "response" } }`. Assert `interaction.editReply({ content: "response" })` was called. Assert tool result is `{ content: [{ type: "text", text: "sent" }] }`.

---

### mcp-platform-connectors.AC2.5

**Criterion:** `discord_respond_interaction` with expired callback_id returns error.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/platforms/src/__tests__/discord-server.test.ts` |

**What to verify:** Inject a mock interaction with `createdAt` set to 15 minutes ago (past the 14-minute TTL). Call `tools/call` with `{ name: "discord_respond_interaction", arguments: { callback_id: "expired-id", content: "late response" } }`. Assert tool result has `isError: true` and content text contains "expired" or "not found". Assert `interaction.editReply()` was NOT called.

---

### mcp-platform-connectors.AC2.6

**Criterion:** Tool execute closure proxies to MCP server's CallTool and returns result.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` |

**What to verify:** Register a mock MCP server with a tool "test_tool" that returns `{ content: [{ type: "text", text: "result-value" }] }`. Discover tools via `PlatformMcpRegistry`. Get the RegisteredTool for "test_tool". Call its `execute({ param: "x" })`. Assert the underlying MCP client's `callTool` was invoked with `{ name: "test_tool", arguments: { param: "x" } }`. Assert the execute closure returns `"result-value"`. Also test error case: server returns `isError: true` -- assert execute returns `"Error: ..."`.

---

## AC3: Platform tools scoped to correct threads

### mcp-platform-connectors.AC3.1

**Criterion:** Event task thread receives platform tools for its bound connector only.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` |

**What to verify:** Set up two MCP servers ("discord" with tools A, B; "slack" with tools C, D). Create an event task with connector handle bound to "discord". Call `registry.getToolsForThread(threadId)`. Assert result contains tools A and B only. Assert tools C and D are NOT present.

---

### mcp-platform-connectors.AC3.2

**Criterion:** Dispatcher task receives tools from ALL connected platform servers.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` |

**What to verify:** Register two MCP servers ("discord" and "slack") with distinct tools. Create the dispatcher task and assign it a thread. Call `registry.isDispatcherThread(threadId)` -- assert true. Call `registry.getAllPlatformTools()`. Assert the result contains tools from BOTH servers (A, B from discord AND C, D from slack).

---

### mcp-platform-connectors.AC3.3

**Criterion:** Threads not bound to any connector handle receive no platform tools.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` |

**What to verify:** Create a regular thread (not linked to any event task). Call `registry.getToolsForThread(threadId)`. Assert empty map returned. Also test: create a thread with an event task but NO connector handle linked to that task. Call `getToolsForThread()`. Assert empty map.

---

### mcp-platform-connectors.AC3.4

**Criterion:** Tool scoping resolves through thread -> task -> connector handle -> server_name chain.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` |

**What to verify:** Set up the full chain: create a thread, create an event task with `thread_id` pointing to that thread, create a connector handle with `task_id` pointing to that task and `server_name = "discord"`. Register "discord" server with tools. Call `getToolsForThread(threadId)`. Assert it resolves through the chain and returns discord's tools. Then change the connector handle's `server_name` to "slack" (with slack server registered). Re-query -- assert slack's tools are now returned.

---

## AC4: Dispatcher discovers and binds new conversations

### mcp-platform-connectors.AC4.1

**Criterion:** Dispatcher wakes on `notifications/events/list_changed` from MCP server.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` |

**What to verify:** Register an MCP server that emits `notifications/events/list_changed`. Set up an eventBus listener for `"connector:list_changed"`. Trigger the notification from the server. Assert the eventBus receives `{ server_name: "<name>" }`. Verify that calling `scheduler.onEvent("connector:list_changed", payload)` matches the dispatcher task's `trigger_spec` and would mark it for execution.

---

### mcp-platform-connectors.AC4.2

**Criterion:** `connector_channels` returns available event types with existing binding annotations.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` |

**What to verify:** Register a server with 3 event types on `events/list`. Create one connector handle binding one of those event types. Call `connector_channels` tool with the server name. Parse the JSON response. Assert 3 event entries returned. Assert one entry has `bound: true` (the one with existing handle). Assert two entries have `bound: false`.

---

### mcp-platform-connectors.AC4.3

**Criterion:** `connector_attach` creates connector handle + event task + thread with history retention.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` |

**What to verify:** Call `connector_attach` with `{ server_name: "discord", event_name: "message.received", event_args: { channel_id: "456" } }`. After execution, query the DB and assert:
1. `connector_handles` row exists with correct `server_name`, `event_name`, `event_args`, `delivery_mode = "push"`, non-null `task_id`
2. `tasks` row exists with `type = "event"`, `trigger_spec = "connector:event:<handle_id>"`, `thread_id` set
3. `threads` row exists with `interface = "platform"`, `id` matching the task's `thread_id`
4. Task has `no_history = 0` (history retention enabled)
5. All three rows have `change_log` entries (outbox pattern)

---

### mcp-platform-connectors.AC4.4

**Criterion:** `connector_attach` for already-bound (server, event, args) tuple returns error.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` |

**What to verify:** Call `connector_attach` once successfully. Call it again with identical `(server_name, event_name, event_args)`. Assert the second call returns an error string containing "already exists". Assert no new `connector_handles`, `tasks`, or `threads` rows were created by the second call.

---

### mcp-platform-connectors.AC4.5

**Criterion:** Newly attached subscription replays buffered events via cursor.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` |

**What to verify:** Emit 3 events from the MCP server BEFORE calling `connector_attach` (events are buffered in the server's ring buffer). Call `connector_attach` -- the subscription starts with no cursor, so replay should deliver all buffered events. Assert that the event task's thread receives a developer-role message containing the 3 buffered events. This confirms the `events/stream` request with null cursor triggers replay from the beginning.

---

### mcp-platform-connectors.AC4.6

**Criterion:** Periodic cron fallback wakes dispatcher even without list_changed.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts` |

**What to verify:** Seed the dispatcher task. Set its `next_run_at` to a timestamp in the past (simulating the cron fallback interval elapsing). Run the scheduler's tick/phase1 logic. Assert the dispatcher task is selected for execution (status transitions to "running" or equivalent). This verifies the dispatcher can wake independently of `list_changed` events.

---

## AC5: Delivery mode transparency

### mcp-platform-connectors.AC5.1

**Criterion:** Push-mode subscription receives events via `notifications/events/event` and delivers batch to task.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Create a push-mode connector handle and activate its subscription. Emit an event from the MCP server via `notifications/events/event`. Wait for the flush timer (or force flush). Assert a developer-role message appears in the task's thread. Assert the `connector:event` event was emitted on the eventBus with correct `{ trigger_key, task_id, handle_id, batch_size }`.

---

### mcp-platform-connectors.AC5.2

**Criterion:** Poll-mode handle's timer calls `events/poll` at server-specified interval.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Create a poll-mode connector handle and activate its subscription. Mock the MCP server's `events/poll` response to return `{ events: [...], nextPollSeconds: 2 }`. Advance time past 2 seconds (use fake timers or short real delay). Assert the MCP client sent an `events/poll` request. Assert `deliverBatch` was called with the returned events.

---

### mcp-platform-connectors.AC5.3

**Criterion:** Poll with no new events produces no inference cost (no task wake).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Create a poll-mode handle. Configure the MCP server's `events/poll` response to return `{ events: [], nextPollSeconds: 2 }`. Trigger the poll timer. Assert NO `connector:event` event was emitted on the eventBus. Assert NO new developer-role messages were inserted in the task thread. The timer reschedules for the next interval but produces zero observable side effects.

---

### mcp-platform-connectors.AC5.4

**Criterion:** Both modes produce identical developer-role messages from event task's perspective.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Create two connector handles for the same event type: one push-mode, one poll-mode (different threads/tasks). Deliver the same event data through both paths. Read the developer-role messages from each thread. Assert the `content` field is byte-identical between both messages. The event batch content format is determined solely by `deliverBatch()`, which both modes call.

---

### mcp-platform-connectors.AC5.5

**Criterion:** Cursor persisted after each successful batch delivery.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Activate a push-mode subscription. Emit 3 events with cursors "1", "2", "3". After the batch is delivered (developer-role message persisted), query the `connector_handles` row. Assert `cursor = "3"` (last event's cursor). Emit 2 more events with cursors "4", "5". After delivery, assert `cursor = "5"`.

---

## AC6: Leader election and failover

### mcp-platform-connectors.AC6.1

**Criterion:** Only leader host instantiates MCP server + transport pair.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/relay-integration.integration.test.ts` |

**What to verify:** Create a PlatformMcpRegistry. Simulate leader election win by calling the leader adapter's `connect()` method. Assert `registry.getServerNames().length > 0` (servers registered). Create a second registry instance (standby). Do NOT call `connect()` on it. Assert `standbRegistry.getServerNames().length === 0` (no servers).

---

### mcp-platform-connectors.AC6.2

**Criterion:** Non-leader hosts have no MCP server, no platform tools, no subscriptions.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/relay-integration.integration.test.ts` |

**What to verify:** Create a PlatformMcpRegistry without calling `registerServer()` (simulating non-leader). Assert `getServerNames()` returns empty array. Assert `getAllPlatformTools()` returns empty map. Assert `getToolsForThread(anyThreadId)` returns empty map. Verify no poll timers or stream subscriptions are active (no background activity).

---

### mcp-platform-connectors.AC6.3

**Criterion:** On failover, new leader reconstitutes subscriptions from connector_handles table with correct cursors.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Create connector handles in the DB with `cursor = "42"` and linked tasks. Create a new PlatformMcpRegistry (simulating failover to new leader). Register the MCP server. Call `registry.reconnectAll()`. Assert all handles have active subscriptions. Verify the `events/stream` request sent to the MCP server includes `cursor: "42"` (resumes from stored position).

---

### mcp-platform-connectors.AC6.4

**Criterion:** Replayed events after failover resume from stored cursor (no duplicates if upstream supports replay).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts` |

**What to verify:** Store cursor "5" in a connector handle. Set up the MCP server to buffer events with cursors 3, 4, 5, 6, 7. Call `reconnectAll()` (which sends `events/stream` with cursor "5"). Assert the server replays only events 6 and 7 (those after cursor "5"). Assert only events 6 and 7 are delivered via `deliverBatch()`. Verify no duplicate messages in the task thread.

---

### mcp-platform-connectors.AC6.5

**Criterion:** `hosts.platforms` advertised correctly for relay platform affinity routing.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/relay-integration.integration.test.ts` |

**What to verify:** Bootstrap the registry with a "discord" server registered. Verify the startup code writes `hosts.platforms` via `updateRow` with `JSON.stringify(["discord"])`. Query the `hosts` table for the local site_id. Assert `JSON.parse(row.platforms)` contains `["discord"]`. This is what the hub's `selectIntakeHost()` uses for platform affinity routing.

---

## AC7: Relay intake preserved

### mcp-platform-connectors.AC7.1

**Criterion:** Event listener writes relay intake entries with platform field.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/relay-integration.integration.test.ts` |

**What to verify:** Configure `PlatformMcpRegistry` in multi-host mode (hubSiteId set, different from local siteId). Deliver an event batch via `deliverBatch()`. Query `relay_outbox` for entries with `kind = "intake"`. Assert one entry exists with `payload` containing `{ platform: "<server_name>", thread_id, message_id }`. Verify the `platform` field matches the subscription's server name.

---

### mcp-platform-connectors.AC7.2

**Criterion:** Hub routes intake to host with platform affinity (leader).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/relay-integration.integration.test.ts` |

**What to verify:** Set up two mock host entries in the `hosts` table: host A with `platforms: '["discord"]'`, host B with `platforms: '[]'`. Simulate the hub's `selectIntakeHost()` logic (or call it directly if exported) with an intake payload containing `platform: "discord"`. Assert it selects host A. Test the negative: intake with `platform: "slack"` where no host has slack -- assert fallback behavior (selects any available host or errors).

---

### mcp-platform-connectors.AC7.3

**Criterion:** `executeProcess()` injects platform tools from new registry.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/platforms/src/__tests__/relay-integration.integration.test.ts` |

**What to verify:** Set up a PlatformMcpRegistry with registered server and discovered tools. Create the full thread -> task -> connector handle chain. Invoke the relay processor's `executeProcess()` (or the tool injection logic isolated from it) with the thread_id from the chain. Assert the resulting `loopConfig.platformTools` (or equivalent) contains the platform tools from the registry. Verify tools are callable (execute closure returns expected result from mock server).

---

## AC8: Config unchanged, legacy removed

### mcp-platform-connectors.AC8.1

**Criterion:** Existing `platforms.json` config loads without modification.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/config-schemas.test.ts` |

**What to verify:** Parse a known-good `platforms.json` content through the `platformsConfigSchema` (or `connectorConfigSchema`). Assert it parses successfully with no Zod errors. The test input should match the documented format:
```json
{
  "connectors": [{
    "platform": "discord",
    "token": "test-token",
    "allowed_users": ["user1"],
    "leadership": "auto",
    "failover_threshold_ms": 30000
  }]
}
```
Also verify that adding an unknown key to the config fails parse (strict mode enforced).

---

### mcp-platform-connectors.AC8.2

**Criterion:** No references to old `PlatformConnector` interface remain in codebase.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit (static analysis) |
| Test file | `packages/platforms/src/__tests__/legacy-removal.test.ts` |

**What to verify:** Run a grep/find across all `packages/` TypeScript source files for the following identifiers: `PlatformConnector` (interface name), `PlatformConnectorRegistry` (old class), `DiscordConnector`, `DiscordInteractionConnector`, `DiscordClientManager`, `deliverPlatformPayload`, `verifyDelivery`, `runPostLoopDeliveryCheck`, `getPlatformTools` (old method), `onLoopComplete`. Assert zero matches in non-test, non-deleted files. This can be implemented as a test that shells out to `grep -r` or reads the filesystem.

---

### mcp-platform-connectors.AC8.3

**Criterion:** `platform:deliver` and `platform:webhook` event types removed.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit (static analysis) |
| Test file | `packages/platforms/src/__tests__/legacy-removal.test.ts` |

**What to verify:** Read the contents of `packages/shared/src/events.ts`. Assert the EventMap interface does NOT contain keys `"platform:deliver"` or `"platform:webhook"`. Also grep across all source files for string literals `"platform:deliver"` and `"platform:webhook"` -- assert zero matches.

---

### mcp-platform-connectors.AC8.4

**Criterion:** Webhook route `POST /hooks/:platform` removed.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit (static analysis) |
| Test file | `packages/platforms/src/__tests__/legacy-removal.test.ts` |

**What to verify:** Grep across `packages/web/` for route patterns containing `hooks/:platform` or `/hooks/`. Assert zero matches. Also verify that no Hono route handler file named `hooks.ts` or equivalent exists under `packages/web/src/routes/`.

---

### mcp-platform-connectors.AC8.5

**Criterion:** All packages typecheck clean.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration (build verification) |
| Test file | (CI pipeline / manual: `bun run typecheck`) |

**What to verify:** Run `bun run typecheck` (which invokes `tsc -p packages/<name> --noEmit` for each package sequentially). Assert exit code 0 with no type errors. This is the final gate that confirms all removed types, deleted files, and new code integrate cleanly.

---

## Human Verification Items

The following criteria have aspects that benefit from human verification in addition to automated tests:

### mcp-platform-connectors.AC2.1 (supplemental)

**Criterion:** `discord_send_message` sends content to correct Discord channel (live behavior).

| Field | Value |
|---|---|
| Verification | Human verification |
| Justification | Automated tests use a mocked Discord.js client. Verifying actual Discord API delivery, rate limiting behavior, and correct channel resolution in production requires a live Discord bot connected to a real server. |
| Verification approach | Deploy to staging environment with a test Discord bot. Send a message via the agent. Verify the message appears in the expected DM channel within 5 seconds. Verify typing indicator is visible before the message lands. |

---

### mcp-platform-connectors.AC2.3 (supplemental)

**Criterion:** Typing indicator starts and stops within `discord_send_message` execution (user perception).

| Field | Value |
|---|---|
| Verification | Human verification |
| Justification | The typing indicator UX (visible "typing..." badge in Discord UI, timing relative to message delivery) cannot be observed by automated tests. Unit tests verify API call ordering but not the user-visible behavior. |
| Verification approach | Trigger a response that requires a long message. Observe in Discord that the typing indicator appears before the first message chunk arrives. Confirm it disappears after the last chunk is sent. |

---

### mcp-platform-connectors.AC4.5 (supplemental)

**Criterion:** Newly attached subscription replays buffered events via cursor (live Discord context).

| Field | Value |
|---|---|
| Verification | Human verification |
| Justification | The integration test verifies replay with a stub server. In production, replay depends on the Discord MCP server's ring buffer not having been pruned, and on the Discord gateway backfill API behaving correctly with the cursor token. Timing-dependent behavior under real gateway reconnection conditions requires live observation. |
| Verification approach | Send 3 messages to the bot's DM while the connector is not yet attached. Then trigger the dispatcher to attach. Verify all 3 messages appear in the event task's thread (not just the latest one). |

---

### mcp-platform-connectors.AC6.3 (supplemental)

**Criterion:** On failover, new leader reconstitutes subscriptions (live cluster behavior).

| Field | Value |
|---|---|
| Verification | Human verification |
| Justification | Failover involves network timing, leader election consensus, and real Discord gateway reconnection. Integration tests simulate these with mocks, but actual multi-host failover behavior (especially around gateway session resumption and event loss windows) can only be observed in a live cluster. |
| Verification approach | Run two-host cluster with leader on host A. Kill host A's process. Observe host B assumes leadership within `failover_threshold_ms`. Send a Discord DM after failover. Verify host B receives and processes the message (event task thread gets the message, agent responds). |

---

### mcp-platform-connectors.AC8.1 (supplemental)

**Criterion:** Existing `platforms.json` config loads without modification (real deployment).

| Field | Value |
|---|---|
| Verification | Human verification |
| Justification | While schema parsing is tested automatically, verifying that a production `platforms.json` file from an existing deployment loads correctly after upgrading confirms no subtle field semantics changed (e.g., default values, type coercion, optional-to-required transitions). |
| Verification approach | Take the `platforms.json` from the production `~/bound/config/` directory. Start the updated binary with `--config-dir ~/bound/config`. Verify startup completes without parse errors. Verify the Discord bot connects and responds to a test DM. |
