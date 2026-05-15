# Test Plan: Remove Dispatcher

## Prerequisites

- System built and installed: `bun run build && cp ./dist/bound* ~/.local/bin/`
- Production database at `~/bound/data/` with existing `connector_handles` rows (at least one active Discord subscription)
- Discord bot token configured in `~/bound/config/platforms.json`
- System is NOT currently running (fresh start required for startup verification)
- `bun test packages/platforms` passing (106 tests, 0 failures)

## Phase 1: Startup Subscription Activation (AC5.1)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `bound query "SELECT id, server_name, event_name, task_id FROM connector_handles WHERE deleted = 0"` to capture existing handles before startup | Table of active connector handles displayed with their IDs, server names, event names, and linked task IDs |
| 2 | Start the system: `cd ~/bound && bound start` | System boots without errors |
| 3 | Observe startup logs (stdout or `~/bound/data/bound.log` depending on configuration) | Logs show `activateSubscription()` or subscription-related messages for each handle ID captured in step 1 |
| 4 | Check that no "Error" or "failed to activate" messages appear for any handle | Clean activation for all handles |
| 5 | Wait 30 seconds for leader election to complete and subscriptions to stabilize | No crash or restart loop |

## Phase 2: Event Delivery Through Connector Handle (AC5.2)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Identify one subscribed Discord channel from step 1 of Phase 1. Run `bound query "SELECT ch.id, ch.server_name, ch.event_name, ch.event_args, ch.task_id, t.thread_id FROM connector_handles ch JOIN tasks t ON ch.task_id = t.id WHERE ch.deleted = 0 LIMIT 1"` | Returns one row with handle ID, task ID, and thread ID |
| 2 | Record the `task_id` and `thread_id` from the result. Run `bound query "SELECT last_run_at FROM tasks WHERE id = '<task_id>'"` to capture the current `last_run_at` timestamp | Note the timestamp (may be null if never triggered, or a past ISO timestamp) |
| 3 | Send a test message in the subscribed Discord channel (from a separate Discord account or bot-test channel) | Message appears in Discord |
| 4 | Wait 10-30 seconds for the event pipeline to deliver the event | N/A (waiting for async delivery) |
| 5 | Run `bound query "SELECT last_run_at, status FROM tasks WHERE id = '<task_id>'"` | `last_run_at` is newer than the timestamp recorded in step 2; status should be "pending" or "running" (task woke and executed) |
| 6 | Verify the event task produced a response: `bound query "SELECT id, role, content FROM messages WHERE thread_id = '<thread_id>' ORDER BY created_at DESC LIMIT 3"` | Shows recent messages including an `assistant` role response (the event task processed the incoming event and generated output) |
| 7 | Check via web UI at `http://localhost:3001`: navigate to the event task's thread | Thread shows the event delivery and agent response in the conversation view |

## End-to-End: Full Attach-Deliver-Detach Lifecycle

Validates the complete lifecycle of a new subscription created via the connector tool, from attach through event delivery to detach, confirming all components integrate correctly after dispatcher removal.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open the web UI at `http://localhost:3001`. Create a new thread (or use an existing conversation). | Thread opens |
| 2 | Ask the agent: "List all platform servers" | Agent calls the `connector` tool with `action: "list"` and reports connected servers (should include "discord") |
| 3 | Ask the agent: "Show me the available events for the discord server" | Agent calls `connector` with `action: "channels", server_name: "discord"` and displays events with bound/unbound annotations |
| 4 | Ask the agent: "Subscribe to message.received events in channel <test-channel-id>" (use a test channel ID) | Agent calls `connector` with `action: "attach"` and reports success with a handle ID, task ID, and thread ID |
| 5 | Verify via DB: `bound query "SELECT * FROM connector_handles WHERE deleted = 0 ORDER BY created_at DESC LIMIT 1"` | New handle exists with correct server_name, event_name, event_args containing the channel ID |
| 6 | Verify the event task was created: `bound query "SELECT id, type, thread_id, trigger_spec FROM tasks WHERE id = '<task_id>'"` | Task has type=event, trigger_spec starts with `connector:event:`, and is linked to a thread |
| 7 | Verify the thread was created: `bound query "SELECT id, interface FROM threads WHERE id = '<thread_id>'"` | Thread exists with `interface = 'platform'` |
| 8 | Send a message in the test Discord channel | Message appears in Discord |
| 9 | Wait 10-30 seconds. Check `bound query "SELECT last_run_at FROM tasks WHERE id = '<task_id>'"` | `last_run_at` is populated with a recent timestamp |
| 10 | Ask the agent: "Detach from that subscription" (provide the handle ID if needed) | Agent calls `connector` with `action: "detach"` and reports success |
| 11 | Verify cleanup: `bound query "SELECT deleted FROM connector_handles WHERE id = '<handle_id>'"` | `deleted = 1` |
| 12 | Verify task cleanup: `bound query "SELECT deleted FROM tasks WHERE id = '<task_id>'"` | `deleted = 1` |
| 13 | Send another message in the test Discord channel, wait 30 seconds | No new task execution occurs (the handle is soft-deleted, subscription should stop) |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC5.1: Existing connector_handles activate at startup | Depends on leader election, Discord gateway connection, and real DB state that cannot be meaningfully unit-tested | Phase 1 steps 1-5: start system fresh, verify logs show activation for each existing handle |
| AC5.2: connector:event:{handleId} triggers wake event tasks | Requires end-to-end flow through live Discord gateway delivering real events to the scheduler trigger mechanism | Phase 2 steps 1-7: send Discord message, verify task `last_run_at` updates, confirm agent response in thread |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 No dispatcher references | Grep verification (zero matches) | -- |
| AC1.2 No connector:list_changed | Grep verification (zero matches) | -- |
| AC1.3 Build + tests pass | `bun test packages/platforms` (106 pass) | -- |
| AC2.1 list returns all servers | `connector-tool.test.ts` "lists local platform servers..." | E2E step 2 |
| AC2.2 channels returns annotated events | `connector-tool.test.ts` "lists events and annotates bound channels" | E2E step 3 |
| AC2.3 channels remote fallback | `connector-tool.test.ts` "uses remotePlatformRequest..." | -- |
| AC2.4 attach creates handle+task+thread | `connector-tool.test.ts` "creates all resources with correct linkage" | E2E steps 4-7 |
| AC2.5 attach activates subscription | `connector-tool.test.ts` "calls activateSubscription..." | E2E step 8-9 |
| AC2.6 detach soft-deletes | `connector-tool.test.ts` "soft-deletes both handle and associated task" | E2E steps 10-12 |
| AC2.7 attach idempotency | `connector-tool.test.ts` "returns error when handle already exists" | -- |
| AC2.8 detach not found | `connector-tool.test.ts` "returns error when handle_id not found" | -- |
| AC2.9 channels no relay error | `connector-tool.test.ts` "returns error for missing server..." | -- |
| AC3.1 discord_list_channels readOnlyHint | `annotation-pipeline.test.ts` first test | -- |
| AC3.2 annotations preserved | `annotation-pipeline.test.ts` "preserves annotations..." | -- |
| AC3.3 getReadOnlyPlatformTools filtering | `annotation-pipeline.test.ts` "returns only tools..." | -- |
| AC3.4 user-facing = readOnly + connector | `tool-scoping.integration.test.ts` "user-facing thread receives..." | E2E step 2-3 (agent has read-only tools in normal thread) |
| AC3.5 user-facing excludes write tools | `tool-scoping.integration.test.ts` "does NOT receive write tools" | -- |
| AC3.6 no annotations = excluded | `annotation-pipeline.test.ts` "excludes tools with no annotations..." | -- |
| AC4.1 event thread gets all server tools | `tool-scoping.integration.test.ts` "receives ALL tools..." | E2E step 9 (event task can send messages) |
| AC4.2 event thread excludes other servers | `tool-scoping.integration.test.ts` "does NOT receive...other server tools" | -- |
| AC5.1 startup activation | -- | Phase 1 steps 1-5 |
| AC5.2 event trigger wakes task | -- | Phase 2 steps 1-7 |
| AC5.3 no DB migration | Git diff verification (empty) | -- |
