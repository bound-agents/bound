# Human Test Plan: RxJS Async Processing Refactor

**Date:** 2026-05-02
**Implementation plan:** `docs/implementation-plans/2026-05-01-rxjs-async-refactor/`

## Automated Coverage Summary

27 of 28 acceptance criteria are fully covered by automated tests. AC5.3 (`bun run build` produces working binary) requires human verification of the compiled binary.

**Test files:**
- `packages/agent/src/__tests__/rx-utils.test.ts` — 9 tests (fromEventBus, pollDb)
- `packages/agent/src/__tests__/relay-stream$.test.ts` — 8 tests (AC1.1-AC1.12)
- `packages/agent/src/__tests__/relay-stream.test.ts` — 24 tests (migrated from old relayStream)
- `packages/agent/src/__tests__/relay-stream.integration.test.ts` — 9 tests + 1 skip
- `packages/agent/src/__tests__/relay-wait$.test.ts` — 7 tests (AC2.1-AC2.5)
- `packages/agent/src/__tests__/relay-processor.test.ts` — 51 tests (AC3.1-AC3.6)
- `packages/platforms/src/__tests__/discord-interaction.test.ts` — 43 tests (AC4.1-AC4.4)

## Human Verification Checklist

### AC5.3: Build produces working binary

- [ ] Run `bun run build`
- [ ] Verify `dist/bound` exists
- [ ] Run `./dist/bound --help` — should print usage without errors
- [ ] Run `./dist/bound --version` — should print version
- [ ] Verify binary size is reasonable (expected ~85MB)

### Relay stream behavior (smoke test)

- [ ] Start `bound start` with a spoke-hub configuration
- [ ] Send a message that triggers relay inference
- [ ] Verify chunks stream correctly (no gaps, correct ordering)
- [ ] Verify relay metadata is captured (check turns table)

### Relay wait behavior (smoke test)

- [ ] Send a message that triggers a remote tool call
- [ ] Verify the tool result is returned correctly
- [ ] Verify relay metrics are recorded in turns table

### Discord polling (smoke test)

- [ ] Send a message via Discord slash command
- [ ] Verify the response is delivered via editReply
- [ ] Disconnect the Discord connector while a poll is active
- [ ] Verify no timeout error is sent (clean disconnect)

### Relay processor tick (smoke test)

- [ ] Start the system and verify relay processor is processing entries
- [ ] Write an outbox entry manually — verify it triggers immediate processing (not waiting for interval)
- [ ] Stop the system — verify no leaked timers or error logs
