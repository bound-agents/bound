# MCP Relay Transport — Test Requirements

Generated from: docs/design-plans/2026-03-25-mcp-relay.md

## Automated Tests

### AC1: Cross-host MCP calls via relay

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC1.1 | integration | `packages/sync/src/__tests__/relay-e2e.integration.test.ts` | Spoke A writes tool_call targeting Spoke B, syncs through hub, Spoke B executes and responds, Spoke A receives result matching expected output (3-instance flow: Spoke A -> Hub -> Spoke B -> Hub -> Spoke A) |
| AC1.2 | integration | `packages/sync/src/__tests__/relay.integration.test.ts` | Spoke writes relay outbox entry targeting hub's own siteId, syncs, hub executes locally via RelayExecutor callback during RELAY phase, spoke receives result in relay_inbox in the same sync response (single round-trip) |
| AC1.3 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Inbox entry with kind `resource_read` triggers `client.readResource(uri)` call on local MCP client, response with resource content written to outbox with `ref_id` linking to request |
| AC1.4 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Inbox entry with kind `prompt_invoke` triggers `client.invokePrompt(name, args)` call on local MCP client, prompt result written to outbox with correct `ref_id` |
| AC1.5 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Inbox entry with kind `cache_warm` reads requested file paths, writes file content to outbox; when combined response exceeds `max_payload_bytes`, splits into one result message per file (each under 2MB, same `ref_id`, final chunk marked `complete: true`) |
| AC1.6 | unit | `packages/agent/src/__tests__/relay-router.test.ts` | `findEligibleHosts()` called with a tool name not advertised by any host in the `hosts` table returns `{ ok: false, error: "Tool ... not available on any remote host" }` |
| AC1.7 | unit | `packages/agent/src/__tests__/relay-router.test.ts` | All hosts advertising the requested tool have `online_at` older than 5 minutes; `isHostStale()` returns true for each, routing reports "tool not reachable" with host name and staleness duration |
| AC1.8 | integration | `packages/sync/src/__tests__/relay-e2e.integration.test.ts` | NAT'd host (no `sync_url` in hosts table) receives tool_call via sync polling only (eager push skipped), executes and responds; requester receives result via polling within expected latency bounds |

### AC2: Eager push for addressable hosts

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC2.1 | unit | `packages/sync/src/__tests__/eager-push.test.ts` | Hub receives relay message for addressable spoke, POSTs to spoke's `{sync_url}/api/relay-deliver` with Ed25519-signed request, spoke receives and inserts entries |
| AC2.2 | unit | `packages/sync/src/__tests__/eager-push.test.ts` | Same relay entry (same UUID PK) delivered first via eager push then via sync; spoke's `INSERT OR IGNORE` deduplicates, resulting in exactly one inbox row |
| AC2.3 | unit | `packages/sync/src/__tests__/eager-push.test.ts` | Spoke's `/api/relay-deliver` returns 500 or is unreachable; `eagerPushToSpoke()` returns false, no error propagated to requester, message remains in hub outbox for sync delivery |
| AC2.4 | unit | `packages/sync/src/__tests__/reachability.test.ts` | Full state transition: host starts reachable, 3 consecutive push failures mark unreachable, subsequent pushes are skipped, a successful sync resets to reachable with failureCount=0 |

### AC3: Old proxy infrastructure deleted

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC3.1 | integration | `packages/sync/src/__tests__/relay-e2e.integration.test.ts` | HTTP POST to `/api/mcp-proxy` returns 404 |
| AC3.2 | integration | `packages/sync/src/__tests__/relay-e2e.integration.test.ts` | HTTP POST/GET to `/api/file-fetch` returns 404 |
| AC3.3 | unit | (codebase grep during Phase 8 Task 2 verification) | Grep all `.ts` source files (excluding docs/) for `proxyToolCall` — zero matches confirm function is fully removed |
| AC3.4 | unit | (build verification during Phase 8 Task 3) | `bun run typecheck` and `bun run lint` pass with zero errors across all packages; `bun test --recursive` passes with no broken references to deleted proxy code |

### AC4: Hub migration drain

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC4.1 | integration | `packages/sync/src/__tests__/relay-drain.integration.test.ts` | `boundctl set-hub` sets `relay_draining = "true"` in `host_meta`, polls relay_outbox until empty, then proceeds with hub switch and clears drain flag |
| AC4.2 | unit | `packages/sync/src/__tests__/relay-drain.integration.test.ts` | Spoke sync relay phase with `relayDraining = true`: outbox contains `tool_call` and `resource_read` entries, only response-kind and cancel entries are sent, request-kind entries remain with `delivered = 0` |
| AC4.3 | unit | `packages/sync/src/__tests__/relay-drain.integration.test.ts` | Spoke sync relay phase with `relayDraining = true`: `result`, `error`, and `cancel` entries are all sent normally |
| AC4.4 | integration | `packages/sync/src/__tests__/relay-drain.integration.test.ts` | After hub switch, spoke's held request-kind entries (still `delivered = 0`) are sent in the first relay sync with the new hub; new hub receives and processes them |
| AC4.5 | integration | `packages/sync/src/__tests__/relay-drain.integration.test.ts` | Drain timeout reached (configured to short value for test) with outbox still containing undelivered entries; hub logs warning and proceeds with hub switch anyway; drain flag cleared |

### AC5: Idempotency

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC5.1 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Two inbox entries with the same `idempotency_key` processed sequentially; first entry executes MCP tool, second returns cached response from in-memory idempotency cache without calling MCP client again |
| AC5.2 | integration | `packages/sync/src/__tests__/relay.integration.test.ts` | Spoke sends two relay messages with the same `idempotency_key` to hub; hub accepts first and stores it, deduplicates second (both IDs in `relay_delivered`), only one outbox entry created for target |
| AC5.3 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Entry with `idempotency_key` processed and cached; after 5-minute TTL expires (via mocked time or manual cache entry manipulation), same key triggers re-execution rather than cache hit |

### AC6: RELAY_WAIT transparency

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC6.1 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | Agent loop receives `RelayToolCallRequest` from command handler, enters RELAY_WAIT, response pre-populated in relay_inbox, polling finds it and returns `CommandResult` with matching stdout/stderr/exitCode identical to local execution shape |
| AC6.2 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | During RELAY_WAIT, activity status string matches format `"relaying {tool_name} via {host_name}"` with correct substitutions |
| AC6.3 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | First host times out (no response before `expires_at`), agent writes new outbox entry targeting second eligible host, triggers sync, polls second host's response which arrives successfully |
| AC6.4 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | All eligible hosts time out sequentially; after exhausting the host list, agent returns error `CommandResult` with descriptive message listing attempted hosts |
| AC6.5 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | On RELAY_WAIT entry, `sync:trigger` event emitted on eventBus with reason `"relay-wait"` (verified via mock eventBus listener) |

### AC7: Cancel propagation

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC7.1 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | Agent's `aborted` flag set to true during RELAY_WAIT; cancel outbox entry with kind `"cancel"` written to relay_outbox, polling loop stops, `sync:trigger` emitted with reason `"relay-cancel"` |
| AC7.2 | unit | `packages/agent/src/__tests__/relay-wait.test.ts` | Cancel relay outbox entry's `ref_id` matches the original request's outbox entry ID |
| AC7.3 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Cancel entry (kind `"cancel"`) with `ref_id` arrives before matching request is processed; cancel registered in `pendingCancels` set, matching request skipped without MCP client execution, marked processed |
| AC7.4 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Tool execution completes and result written to outbox; cancel with matching `ref_id` arrives afterward; cancel is a no-op (result already sent), no error produced |

### AC8: Metrics & observability

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC8.1 | unit | `packages/core/src/__tests__/relay-metrics.test.ts` | `recordTurnRelayMetrics(db, turnId, "spoke-a", 150)` updates the turns row; subsequent query confirms `relay_target = "spoke-a"` and `relay_latency_ms = 150` |
| AC8.2 | unit | `packages/core/src/__tests__/relay-metrics.test.ts` | Insert a turn without calling `recordTurnRelayMetrics()`; query confirms `relay_target` is NULL and `relay_latency_ms` is NULL |
| AC8.3 | unit | `packages/core/src/__tests__/relay-metrics.test.ts` | `recordRelayCycle()` called with various direction/peer/kind/delivery_method combinations; query `relay_cycles` table confirms all fields recorded correctly |
| AC8.4 | unit | `packages/core/src/__tests__/relay-metrics.test.ts` | Insert relay_cycles entries with `created_at` older than 30 days and entries with recent timestamps; `pruneRelayCycles(db, 30)` deletes only the old entries, recent entries remain |
| AC8.5 | unit | `packages/agent/src/__tests__/commands-help.test.ts` | `commands` command output includes "Built-in" section, "LOCAL (MCP)" section for locally-available tools, and "REMOTE (via relay)" section for relay-only tools with host attribution |

### AC9: Data integrity

| AC | Test Type | File | Verifies |
|----|-----------|------|----------|
| AC9.1 | unit | `packages/core/src/__tests__/relay.test.ts` | `writeOutbox()` with payload exceeding 2MB throws `PayloadTooLargeError`; `insertInbox()` with payload exceeding 2MB throws `PayloadTooLargeError`; payloads under 2MB succeed for both |
| AC9.2 | unit | `packages/agent/src/__tests__/relay-processor.test.ts` | Inbox entry with `expires_at` in the past: processor discards it without executing any MCP tool call, marks entry as processed |
| AC9.3 | unit | `packages/core/src/__tests__/relay.test.ts` | Write outbox entries and mark as delivered with timestamps >5 minutes old; write inbox entries and mark as processed with timestamps >5 minutes old; `pruneRelayTables()` hard-deletes them. Non-delivered/non-processed entries are NOT pruned. Recently delivered/processed entries are NOT pruned. |
| AC9.4 | unit | `packages/sync/src/__tests__/eager-push.test.ts` | POST to `/api/relay-deliver` from a siteId that is NOT the current hub returns 403 "Not from current hub"; POST with valid hub siteId succeeds with 200 |

## Human Verification

| AC | Justification | Verification Approach |
|----|--------------|----------------------|
| AC1.8 (latency aspect) | While functional correctness (NAT'd host receives and responds via polling) is automated, verifying that latency is within expected polling interval bounds (~7.5s vs ~3s eager push) depends on system timing that can be flaky in CI. | Run integration test in a controlled environment. Observe relay_cycles latency_ms values. Confirm NAT'd host latency is roughly sync_interval-scale (not sub-second like eager push). Compare relay_cycles entries: NAT'd host has `delivery_method = "sync"` only, addressable host has `delivery_method = "eager_push"`. |
| AC6.2 (visual confirmation) | The activity status string format is tested programmatically, but whether it displays correctly in the web UI's status area requires visual inspection. | Start a local instance with a remote tool configured. Trigger a remote tool call. Observe the web UI status bar shows `"relaying {tool_name} via {host_name}"` during the relay wait period. Confirm status clears after result returns. |
| AC8.5 (output formatting) | The content of the `commands` output (correct categorization into tiers) is tested, but the readability and alignment of the formatted output is subjective. | Run `commands` in an active agent session with both local and remote MCP tools configured. Visually confirm the three-tier output (Built-in, LOCAL, REMOTE) is clearly separated, tool names are aligned, and REMOTE tools show their host attribution (e.g., `[host: spoke-a]`). |

## Test File Summary

| File | Package | Type | Phase | AC Coverage |
|------|---------|------|-------|-------------|
| `packages/core/src/__tests__/relay.test.ts` | core | unit | 1 | AC9.1, AC9.3 |
| `packages/core/src/__tests__/relay-metrics.test.ts` | core | unit | 7 | AC8.1, AC8.2, AC8.3, AC8.4 |
| `packages/sync/src/__tests__/relay.integration.test.ts` | sync | integration | 2 | AC1.2, AC5.2 |
| `packages/sync/src/__tests__/eager-push.test.ts` | sync | unit | 5 | AC2.1, AC2.2, AC2.3, AC9.4 |
| `packages/sync/src/__tests__/reachability.test.ts` | sync | unit | 5 | AC2.4 |
| `packages/sync/src/__tests__/relay-drain.integration.test.ts` | sync | integration | 6 | AC4.1, AC4.2, AC4.3, AC4.4, AC4.5 |
| `packages/sync/src/__tests__/relay-e2e.integration.test.ts` | sync | integration | 8 | AC1.1, AC1.8, AC3.1, AC3.2 |
| `packages/agent/src/__tests__/relay-router.test.ts` | agent | unit | 3 | AC1.6, AC1.7 |
| `packages/agent/src/__tests__/relay-wait.test.ts` | agent | unit | 3 | AC6.1, AC6.2, AC6.3, AC6.4, AC6.5, AC7.1, AC7.2 |
| `packages/agent/src/__tests__/relay-processor.test.ts` | agent | unit | 4 | AC1.3, AC1.4, AC1.5, AC5.1, AC5.3, AC7.3, AC7.4, AC9.2 |
| `packages/agent/src/__tests__/commands-help.test.ts` | agent | unit | 7 | AC8.5 |
| (codebase grep + build verification) | all | unit | 8 | AC3.3, AC3.4 |

## Test Count by AC

| AC Group | Total Sub-ACs | Automated | Human Verification | Notes |
|----------|--------------|-----------|-------------------|-------|
| AC1 (Cross-host MCP) | 8 | 8 | 1 (latency aspect of AC1.8) | AC1.8 automated for functional correctness |
| AC2 (Eager push) | 4 | 4 | 0 | |
| AC3 (Proxy deletion) | 4 | 4 | 0 | AC3.3/AC3.4 verified via grep + build |
| AC4 (Hub migration drain) | 5 | 5 | 0 | |
| AC5 (Idempotency) | 3 | 3 | 0 | |
| AC6 (RELAY_WAIT) | 5 | 5 | 1 (visual aspect of AC6.2) | AC6.2 automated for string content |
| AC7 (Cancel propagation) | 4 | 4 | 0 | |
| AC8 (Metrics) | 5 | 5 | 1 (formatting of AC8.5) | AC8.5 automated for content correctness |
| AC9 (Data integrity) | 4 | 4 | 0 | |
| **Total** | **42** | **42** | **3 (supplementary)** | All ACs have automated coverage |
