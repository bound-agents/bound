# Test Requirements: Remove Dispatcher

## Automated Tests

| AC ID | Criterion | Test Type | Test File | Phase |
|-------|-----------|-----------|-----------|-------|
| remove-dispatcher.AC1.1 | No references to DISPATCHER_TASK_ID, seedDispatcher, registerConnectorEventListeners, or isDispatcherThread exist in source | Grep verification | N/A (shell command in Phase 4 Task 5) | 4 |
| remove-dispatcher.AC1.2 | No connector:list_changed event emission or handling exists in mcp-registry.ts or server.ts | Grep verification | N/A (shell command in Phase 4 Task 5) | 4 |
| remove-dispatcher.AC1.3 | Build passes and all existing tests pass after removal | Full suite | `bun test --recursive` + `bun run typecheck` | 4 |
| remove-dispatcher.AC2.1 | `list` action returns all connected platform servers (local + cluster-wide from hosts.platforms) | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.2 | `channels` action returns events from a server annotated with bound/unbound status | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.3 | `channels` action falls back to remotePlatformRequest when server is not local | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.4 | `attach` action creates connector_handle, event task (type=event), and thread (interface=platform) with correct linkage | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.5 | `attach` action activates subscription immediately when local leader has the server | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.6 | `detach` action soft-deletes handle and associated task | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.7 | `attach` returns error when handle already exists (idempotency check) | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.8 | `detach` returns error when handle_id not found | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC2.9 | `channels` returns error when server not found locally and no remote relay | Unit | `packages/platforms/src/__tests__/connector-tool.test.ts` | 2 |
| remove-dispatcher.AC3.1 | discord_list_channels is registered with readOnlyHint: true annotation | Unit | `packages/platforms/src/__tests__/annotation-pipeline.test.ts` | 1 |
| remove-dispatcher.AC3.2 | discoverTools() preserves annotations from MCP listTools() response on PlatformRegisteredTool | Unit | `packages/platforms/src/__tests__/annotation-pipeline.test.ts` | 1 |
| remove-dispatcher.AC3.3 | getReadOnlyPlatformTools() returns only tools where annotations.readOnlyHint === true | Unit | `packages/platforms/src/__tests__/annotation-pipeline.test.ts` | 1 |
| remove-dispatcher.AC3.4 | User-facing threads receive readOnly platform tools + connector tool from platformToolResolver | Integration | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` | 3 |
| remove-dispatcher.AC3.5 | User-facing threads do NOT receive write tools (discord_send_message, discord_respond_interaction) | Integration | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` | 3 |
| remove-dispatcher.AC3.6 | Tools with no annotations (readOnlyHint defaults to false) are excluded from user-facing threads | Unit | `packages/platforms/src/__tests__/annotation-pipeline.test.ts` | 1 |
| remove-dispatcher.AC4.1 | Event task threads with a connector handle receive all tools from their bound server | Integration | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` | 3 |
| remove-dispatcher.AC4.2 | Event task threads do NOT receive the connector tool or tools from other servers | Integration | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` | 3 |
| remove-dispatcher.AC5.3 | No DB migration required | Grep verification | N/A (verify no schema.ts changes via git diff in Phase 4 Task 5) | 4 |

## Human Verification

| AC ID | Criterion | Why Not Automated | Verification Approach |
|-------|-----------|-------------------|----------------------|
| remove-dispatcher.AC5.1 | Existing connector_handles rows continue to activate subscriptions at startup | Requires a running system with live DB state and a real platform connector (Discord bot token); startup subscription activation depends on leader election, network, and the Discord gateway connection | Start the system with existing connector_handles rows in the production DB. Verify via logs that `activateSubscription()` fires for each active handle during the bootstrap sequence. Confirm events flow through to event tasks by triggering a message in a subscribed Discord channel and checking that the event task thread receives it. |
| remove-dispatcher.AC5.2 | connector:event:{handleId} triggers still wake event tasks on delivery | Requires end-to-end event flow through a live platform connector delivering real events to the scheduler's trigger mechanism; mocking the entire pipeline would replicate rather than verify the integration | After startup verification (AC5.1), send a Discord message to a subscribed channel. Verify via `boundctl` or the web UI that the corresponding event task wakes, processes the event batch, and produces a response. Check the task's `last_run_at` timestamp updates. |

## Test Strategy Notes

### Phase 1 (`annotation-pipeline.test.ts`)
- Uses `PlatformMcpRegistry` with mock MCP servers that register tools with and without annotations
- Verifies the full pipeline: registration -> listTools() -> discoverTools() -> getReadOnlyPlatformTools()
- Pattern follows existing `dispatcher-tools.integration.test.ts` (real SQLite DB, mock transports)

### Phase 2 (`connector-tool.test.ts`)
- Tests `createConnectorTool()` in isolation with a mock registry and real DB
- Each action handler tested for success, failure, and edge cases
- Uses spy on `registry.activateSubscription` to verify subscription activation without needing a real platform connection
- For `remotePlatformRequest` fallback: test with closure provided and with closure undefined

### Phase 3 (`tool-scoping.integration.test.ts` -- updated)
- Adds new test cases to the existing file (does not replace it)
- Constructs the resolver logic inline (mirrors `scheduler.ts` pattern)
- Tests the two-branch model: event task threads vs. user-facing threads
- Requires DB setup with connector_handles and tasks rows to simulate the handle chain

### Phase 4 (verification via grep + full test suite)
- AC1.1 and AC1.2 are verified by grep commands that must return zero results
- AC1.3 is verified by the full `bun test --recursive` and `bun run typecheck` passing
- AC5.3 is verified by confirming no changes to `packages/core/src/schema.ts`
- AC5.1 and AC5.2 require human verification because they depend on live system state, leader election, and real Discord gateway connections that cannot be meaningfully unit-tested

### Coverage Summary

| Phase | Test File | ACs Covered |
|-------|-----------|-------------|
| 1 | `packages/platforms/src/__tests__/annotation-pipeline.test.ts` | AC3.1, AC3.2, AC3.3, AC3.6 |
| 2 | `packages/platforms/src/__tests__/connector-tool.test.ts` | AC2.1-AC2.9 |
| 3 | `packages/platforms/src/__tests__/tool-scoping.integration.test.ts` | AC3.4, AC3.5, AC4.1, AC4.2 |
| 4 | Grep + full test suite | AC1.1, AC1.2, AC1.3, AC5.3 |
| Human | Live system validation | AC5.1, AC5.2 |
