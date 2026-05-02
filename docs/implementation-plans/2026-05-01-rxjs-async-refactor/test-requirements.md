# RxJS Async Processing Refactor -- Test Requirements

Maps each acceptance criterion from the [design plan](../../design-plans/2026-05-01-rxjs-async-refactor.md) to specific automated tests or human verification steps.

---

## AC1: Relay Stream Observable

| AC ID | Criterion | Test Type | Test File | Verification Description | Human Verification Needed? |
|---|---|---|---|---|---|
| AC1.1 | Chunks arriving in sequence order are emitted immediately without buffering | Unit (marble) | `packages/agent/src/__tests__/relay-stream$.test.ts` | Insert relay_inbox entries with seq 0, 1, 2 in order. Subscribe to `createRelayStream$()`. Assert output chunks arrive in same order without delay (no buffering visible in emission timing). Also verified by migrated test #1 in `packages/agent/src/__tests__/relay-stream.test.ts`. | No |
| AC1.2 | Out-of-order chunks (e.g., seq 0, 2, 1) are reordered and emitted as 0, 1, 2 | Unit (marble) | `packages/agent/src/__tests__/relay-stream$.test.ts` | Insert seq 0 first, then seq 2, then seq 1. Assert the observable emits them as 0, 1, 2 (scan accumulator buffers seq 2 until seq 1 fills the gap). Also covered by migrated test #3 ("chunks reordered by seq"), test #11 ("duplicate stream chunks ignored"), and test #14 ("mixed duplicate and fresh chunks") in `relay-stream.test.ts`. | No |
| AC1.3 | Stream completes normally when `stream_end` chunk is received and all prior sequences are accounted for | Unit (marble) | `packages/agent/src/__tests__/relay-stream$.test.ts` | Insert chunks ending with a `stream_end` entry. Assert the observable completes (no error) after all chunks are emitted. Also covered by migrated test #2 in `relay-stream.test.ts`. | No |
| AC1.4 | First host responding successfully never triggers failover to second host | Unit | `packages/agent/src/__tests__/relay-stream$.test.ts` | Provide two eligible hosts. First host returns chunks successfully. Assert only one relay_outbox entry is written (for first host only) -- no second outbox entry written for second host. | No |
| AC1.5 | Silence timeout on host A triggers failover to host B with cancel outbox entry written for host A | Unit (marble/TestScheduler) | `packages/agent/src/__tests__/relay-stream$.test.ts` | Provide two hosts. First host returns no chunks. Use TestScheduler to advance virtual time past `perHostTimeoutMs`. Assert: (1) cancel outbox entry written for host A, (2) new outbox entry written for host B. Also covered by migrated test #5 in `relay-stream.test.ts`. | No |
| AC1.6 | All hosts exhausting their timeout results in an error emission (not silent completion) | Unit (marble/TestScheduler) | `packages/agent/src/__tests__/relay-stream$.test.ts` | Provide two hosts, both timeout (no chunks inserted). Assert the observable errors with message containing "all 2 eligible host(s) timed out". Also covered by migrated tests #6 and #7 in `relay-stream.test.ts`. | No |
| AC1.7 | Gap detection -- if `nextExpectedSeq` stalls for `MAX_GAP_CYCLES` polls, skip to next buffered sequence | Unit (marble) | `packages/agent/src/__tests__/relay-stream$.test.ts` | Insert seq 0, then seq 3 (gap of 1, 2). After MAX_GAP_CYCLES (6) poll intervals, assert nextExpectedSeq advances to 3 and seq 3 chunks are emitted. Also covered by migrated tests #8, #12, #13, and #15 in `relay-stream.test.ts`. | No |
| AC1.8 | `aborted$` firing mid-stream writes cancel outbox entry and completes the observable (no error) | Unit | `packages/agent/src/__tests__/relay-stream$.test.ts` | Start streaming. Emit on `aborted$` Subject mid-stream. Assert: (1) cancel outbox entry written for current host, (2) observable completes (no error thrown). Also covered by migrated test #4 in `relay-stream.test.ts`. | No |
| AC1.9 | Metadata ref captures `firstChunkLatencyMs` from first non-heartbeat chunk and responding host name | Unit | `packages/agent/src/__tests__/relay-stream$.test.ts` | Provide a `relayMetadataRef` object. After first non-heartbeat chunk arrives, assert `hostName` and `firstChunkLatencyMs` are populated on the ref. Also covered by migrated test #10 in `relay-stream.test.ts`. | No |

## AC2: Relay Wait Observable

| AC ID | Criterion | Test Type | Test File | Verification Description | Human Verification Needed? |
|---|---|---|---|---|---|
| AC2.1 | `result` response kind is parsed, `markProcessed()` called, content string emitted | Unit | `packages/agent/src/__tests__/relay-wait$.test.ts` | Insert a relay_inbox entry with kind `"result"` and a valid `resultPayloadSchema` payload. Subscribe to `createRelayWait$()`. Assert: (1) emitted string matches `buildCommandOutput(stdout, stderr, exit_code)`, (2) the inbox entry's `processed` flag is set to 1. | No |
| AC2.2 | Relay metrics (timing, host) recorded to turns table when `currentTurnId` is set | Unit | `packages/agent/src/__tests__/relay-wait$.test.ts` | Insert a `turns` row, then provide a non-null `currentTurnId`. Insert a result response. After observable completes, assert `turns.relay_target` and `turns.relay_latency_ms` are populated in the DB. | No |
| AC2.3 | `error` response kind from remote host throws typed error | Unit | `packages/agent/src/__tests__/relay-wait$.test.ts` | Insert a relay_inbox entry with kind `"error"` and payload `{ error: "model overloaded", retriable: true }`. Assert emitted string contains `"Remote error: model overloaded"`. | No |
| AC2.4 | Host timeout (30s) triggers failover -- new outbox entry written for next host | Unit (marble/TestScheduler) | `packages/agent/src/__tests__/relay-wait$.test.ts` | Provide two hosts. Do not insert any response for first host. Advance virtual time past 30s. Assert: (1) new outbox entry written for second host with kind `"tool_call"`, (2) insert result for second host, assert it is returned. | No |
| AC2.5 | `aborted$` firing writes cancel outbox entry and completes | Unit | `packages/agent/src/__tests__/relay-wait$.test.ts` | Start waiting. Emit on `aborted$` Subject mid-wait. Assert: (1) cancel outbox entry written for current host, (2) observable completes with the default cancel message (via `firstValueFrom` defaultValue). | No |

## AC3: Relay Processor Tick Loop

| AC ID | Criterion | Test Type | Test File | Verification Description | Human Verification Needed? |
|---|---|---|---|---|---|
| AC3.1 | `processPendingEntries()` called on each interval tick | Integration | `packages/agent/src/__tests__/relay-processor.test.ts` | Start the processor with a short interval (e.g., 50ms). Insert an outbox entry. Use `waitFor()` to assert `processPendingEntries()` picks it up within a few intervals. | No |
| AC3.2 | `relay:outbox-written` event triggers immediate `processPendingEntries()` call (not waiting for next interval) | Integration | `packages/agent/src/__tests__/relay-processor.test.ts` | Start the processor with a long interval (e.g., 10,000ms) so no interval tick fires during the test. Emit `relay:outbox-written` on the eventBus. Use `waitFor()` with a short timeout to assert `processPendingEntries()` is called within milliseconds. | No |
| AC3.3 | `pruneRelayTables` called approximately every 60 seconds | Unit (marble/TestScheduler) | `packages/agent/src/__tests__/relay-processor.test.ts` | Use TestScheduler with the `scheduler` parameter to advance virtual time past 60s. Assert `pruneRelayTables` is called. The TestScheduler approach avoids real 60-second waits. | No |
| AC3.4 | `stop()` (unsubscribe) tears down all timers and prevents further ticks | Integration | `packages/agent/src/__tests__/relay-processor.test.ts` | Start the processor. Call `handle.stop()`. Insert an outbox entry after stop. Wait briefly. Assert the entry is NOT processed (no further tick executions). | No |
| AC3.5 | Exception in `processPendingEntries()` is logged and does not stop subsequent ticks | Integration | `packages/agent/src/__tests__/relay-processor.test.ts` | Corrupt an inbox entry to make `processPendingEntries()` throw. Assert the error is logged. Insert a valid entry after the error. Assert the valid entry is processed on a subsequent tick (recovery). | No |
| AC3.6 | Tick firing while `processPendingEntries()` is still running is dropped (no concurrent execution) | Integration | `packages/agent/src/__tests__/relay-processor.test.ts` | Make `processPendingEntries()` artificially slow (add a delay). Fire multiple wakeup events rapidly. Track concurrent call count. Assert no more than one concurrent execution occurs (`exhaustMap` backpressure). | No |

## AC4: Discord Interaction Polling

| AC ID | Criterion | Test Type | Test File | Verification Description | Human Verification Needed? |
|---|---|---|---|---|---|
| AC4.1 | Assistant response found in DB triggers `deliver()` and completes polling | Integration | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Insert an assistant message into the DB. Call `pollForResponse()`. Assert `editReply` is called with the message content. Existing AC8.1 tests should continue to cover this -- verify they pass with the new RxJS implementation. | No |
| AC4.2 | First poll fires immediately (not after waiting one interval) | Integration | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Insert an assistant message into the DB. Start polling. Assert `editReply` is called within < 100ms (not after waiting 500ms for the first interval tick). This verifies the `startWith(0)` operator fires an immediate first poll. | No |
| AC4.3 | No response within `pollTimeoutMs` triggers timeout error message via `editReply` and cleans up interaction | Integration | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Start polling with a short `pollTimeoutMs` (e.g., 200ms). Do not insert any response. Assert: (1) `editReply` is called with the timeout error string, (2) the interaction is removed from the interactions Map. Existing AC8.2 tests should continue to cover this. | No |
| AC4.4 | `disconnecting$` firing mid-poll completes the observable cleanly (no error, no timeout message) | Integration | `packages/platforms/src/__tests__/discord-interaction.test.ts` | Start polling. After a short delay (50ms), call `disconnect()` (which fires `disconnecting$.next()`). Assert: (1) `editReply` is NOT called with a timeout error, (2) the interactions Map is cleared by `disconnect()`. | No |

## AC5: Cross-Cutting

| AC ID | Criterion | Test Type | Test File | Verification Description | Human Verification Needed? |
|---|---|---|---|---|---|
| AC5.1 | All existing tests pass with no regressions | Full suite | `bun test --recursive` (all test files) | Run the complete test suite. Assert zero failures. Report total pass/fail/skip counts. Compare against pre-refactor baseline to confirm no tests were removed or skipped. | No |
| AC5.2 | `bun run typecheck` clean across all packages | Typecheck | N/A (all packages via `bun run typecheck`) | Run `bun run typecheck`. Assert zero type errors across all packages. This runs `tsc -p packages/<name> --noEmit` for every package sequentially. | No |
| AC5.3 | `bun run build` produces working binary | Build + smoke | N/A (`bun run build` + `./dist/bound --version`) | Run `bun run build`. Assert it succeeds (exit code 0). Run `./dist/bound --version`. Assert it prints the version without errors. | Yes -- after the build succeeds, the binary should be run against a real config directory (`~/bound`) to verify relay streaming, relay waiting, and Discord interactions work end-to-end with live LLM backends. Automated tests cannot cover the full deployed runtime behavior (network timing, actual relay protocol over WS, Discord API interactions). |
| AC5.4 | No dead code from removed imperative implementations remains | Static analysis | N/A (grep-based verification in Phase 6) | Run grep searches for dead code markers: (1) `grep -rn "relayStream\|relayWait\|_relayWaitImpl" packages/agent/src/agent-loop.ts` -- expect no matches, (2) `grep -rn "this.stopped\|private stopped\|tickCount\|PRUNE_EVERY_N_TICKS" packages/agent/src/relay-processor.ts` -- expect no matches for the old flag/counter, (3) `grep -rn "while\s*(true)" packages/platforms/src/connectors/discord-interaction.ts` -- expect no matches, (4) `grep -rn "private disconnecting[^$]" packages/platforms/src/connectors/discord-interaction.ts` -- expect no matches (only `disconnecting$` should exist). These can be automated as a test or CI check, but are more naturally a one-time verification during Phase 6. | No -- fully automatable via grep, but not a persistent test (dead code is verified once at refactor time, not on every CI run). |

---

## Summary

| Category | Total ACs | Fully Automated | Requires Human Verification |
|---|---|---|---|
| AC1: Relay Stream Observable | 9 | 9 | 0 |
| AC2: Relay Wait Observable | 5 | 5 | 0 |
| AC3: Relay Processor Tick Loop | 6 | 6 | 0 |
| AC4: Discord Interaction Polling | 4 | 4 | 0 |
| AC5: Cross-Cutting | 4 | 3 | 1 (AC5.3 -- live runtime smoke test) |
| **Total** | **28** | **27** | **1** |

### New test files created by this refactor

| File | Phase | Covers |
|---|---|---|
| `packages/agent/src/__tests__/rx-utils.test.ts` | 1 | `fromEventBus()` and `pollDb()` utilities (infrastructure) |
| `packages/agent/src/__tests__/relay-stream$.test.ts` | 2 | AC1.1 through AC1.9 |
| `packages/agent/src/__tests__/relay-wait$.test.ts` | 3 | AC2.1 through AC2.5 |

### Existing test files modified by this refactor

| File | Phase | Changes |
|---|---|---|
| `packages/agent/src/__tests__/relay-stream.test.ts` | 2 | All 15 tests migrated from `(loop as any).relayStream()` to `createRelayStream$()` |
| `packages/agent/src/__tests__/relay-processor.test.ts` | 4 | New `describe` block added for AC3.1 through AC3.6 |
| `packages/platforms/src/__tests__/discord-interaction.test.ts` | 5 | New `describe` block added for AC4.1 through AC4.4 |

### Human verification details for AC5.3

AC5.3 requires human verification because the binary must be tested against a live deployment to confirm end-to-end behavior:

1. **Relay streaming** -- Trigger a remote inference request from a spoke. Verify chunks arrive in order, failover works on timeout, and the stream completes normally. This exercises the full relay protocol over WebSocket, which cannot be replicated in unit tests.
2. **Relay waiting** -- Trigger a remote tool call. Verify the response is received and parsed correctly. This exercises the relay inbox/outbox over the sync protocol.
3. **Discord interaction polling** -- Send a Discord slash command. Verify the bot responds within the expected timeframe and that disconnect/reconnect cycles don't leave orphaned polls. This exercises the real Discord API and gateway connection.

The automated build verification (`bun run build` + `./dist/bound --version`) confirms compilation only. Runtime correctness under real network conditions requires manual or staging-environment validation.
