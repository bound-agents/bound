# Human Test Plan: Platform Connectors

Generated from implementation plan: `docs/implementation-plans/2026-03-27-platform-connectors/`

## Prerequisites

- Bun v1.3+ installed
- All dependencies installed (`bun install`)
- All automated tests passing (`bun test --recursive` exits with 0)
- Access to a terminal in the project root
- At least two terminal windows available for multi-instance testing

---

## Phase 1: Schema and Config Migration Verification

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | `bun test packages/core/src/__tests__/schema.test.ts` | All 13 tests pass (5 original + 5 AC1 migration tests + 3 others), 0 fail |
| 1.2 | `bun test packages/shared/src/__tests__/config-schemas.test.ts` | All 34 tests pass (25 original + 9 platform-connectors AC tests), 0 fail |
| 1.3 | Open `packages/shared/src/config-schemas.ts` — confirm no `discordSchema` export and no `discord.json` key in `configSchemaMap` | `discordSchema` absent; `configSchemaMap` contains `"platforms.json"` but not `"discord.json"` |

---

## Phase 2: Relay Kind Handler Verification

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | `bun test packages/agent/src/__tests__/relay-processor.test.ts` | All 24 tests pass, 0 fail |
| 2.2 | `bun test packages/sync/src/__tests__/multi-instance.integration.test.ts --test-name-pattern "AC3.9"` | Both AC3.9 tests pass. Broadcast fan-out creates inbox entries for non-source spokes |
| 2.3 | `bun test packages/sync/src/__tests__/event-broadcast.integration.test.ts` | AC4.3 integration test passes. RelayProcessor fires `test:custom-event` on spokeB's eventBus |

---

## Phase 3: Platforms Package Verification

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | `bun test packages/platforms/src/__tests__/leader-election.test.ts` | All 7 tests pass. Leader election claims/standby/failover/heartbeat all verified |
| 3.2 | `bun test packages/platforms/src/__tests__/registry.test.ts` | All 10 tests pass. `platform:deliver` routing and `WebhookStubConnector` characteristics verified |
| 3.3 | `bun test packages/platforms/src/__tests__/discord-connector.test.ts` | All 15 tests pass. Intake relay, message persistence, chunking, allowlist all verified |
| 3.4 | `bun test packages/platforms/src/__tests__/intake-pipeline.integration.test.ts` | Both integration tests pass. End-to-end intake payload structure validated |

---

## Phase 4: emit Command and Webhook Route

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | `bun test packages/agent/src/__tests__/emit.test.ts` | Both AC4.1 and AC4.2 tests pass |
| 4.2 | `bun test packages/web/src/__tests__/webhooks.test.ts` | All 4 AC7.3 tests pass (discord, telegram, headers, empty body) |

---

## Phase 5: AbortSignal Wiring

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | `bun test packages/llm/src/__tests__/anthropic-driver.test.ts --test-name-pattern "AC8"` | AC8.1 passes. Signal forwarded to fetch |
| 5.2 | `bun test packages/llm/src/__tests__/bedrock-driver.test.ts --test-name-pattern "AC8"` | AC8.2 passes. Signal forwarded to AWS SDK `send()` |
| 5.3 | `bun test packages/llm/src/__tests__/openai-driver.test.ts --test-name-pattern "AC8"` | AC8.3 passes. Signal forwarded to fetch |
| 5.4 | `bun test packages/llm/src/__tests__/ollama-driver.test.ts --test-name-pattern "AC8"` | AC8.4 passes. Signal forwarded to fetch; `global.fetch` restored in `afterAll` |
| 5.5 | `bun test packages/agent/src/__tests__/relay-processor.test.ts --test-name-pattern "AC8.5"` | AC8.5 passes. RelayProcessor inference handler passes `AbortSignal` instance to `backend.chat()` |

---

## Phase 6: discord Package Deletion Verification

| Step | Action | Expected |
|------|--------|----------|
| 6.1 | `ls packages/ \| grep discord` | No output — `packages/discord/` directory does not exist |
| 6.2 | `grep -rn "@bound/discord" packages/ --include="*.ts" --include="*.json" \| grep -v node_modules \| grep -v packages/platforms/src/connectors/discord` | No output — no remaining `@bound/discord` references |
| 6.3 | `bun run typecheck` | 0 errors. No `@bound/discord` resolution failures |

---

## End-to-End: Full Intake Pipeline

Validates the complete path from platform message receipt through relay to agent processing readiness.

1. `bun test packages/platforms/src/__tests__/discord-connector.test.ts --test-name-pattern "should write intake relay"` — verify DiscordConnector writes `intake` to relay_outbox.
2. `bun test packages/agent/src/__tests__/relay-processor.test.ts --test-name-pattern "AC3.3"` — verify RelayProcessor routes intake to correct host via thread affinity.
3. `bun test packages/agent/src/__tests__/relay-processor.test.ts --test-name-pattern "AC3.7"` — verify `platform_deliver` emits on eventBus for delivery back to platform.
4. Confirm the complete message flow (platform → intake relay → hub routing → spoke process → platform_deliver → connector delivery) is covered across these test files with no gaps.

---

## End-to-End: Cross-Host Event Broadcast

Validates that events emitted on one host propagate to all other hosts in the cluster.

1. `bun test packages/agent/src/__tests__/emit.test.ts --test-name-pattern "AC4.1"` — verify emit command writes `event_broadcast` when hub is configured.
2. `bun test packages/sync/src/__tests__/multi-instance.integration.test.ts --test-name-pattern "AC3.9"` — verify broadcast fan-out delivers to all spokes except source.
3. `bun test packages/sync/src/__tests__/event-broadcast.integration.test.ts --test-name-pattern "AC4.3"` — verify RelayProcessor on target spoke fires the event on its eventBus.
4. Confirm the event name propagated through the relay matches the original, and `__relay_event_depth` is set correctly for loop prevention.

---

## End-to-End: LLM Cancellation via AbortSignal

Validates that aborting an inference relay terminates the underlying LLM call.

1. `bun test packages/llm/src/__tests__/anthropic-driver.test.ts --test-name-pattern "AC8.1"` — verify signal forwarded to fetch.
2. `bun test packages/agent/src/__tests__/relay-processor.test.ts --test-name-pattern "AC8.5"` — verify RelayProcessor passes `AbortController.signal` to `backend.chat()`.
3. Together, these confirm the chain: RelayProcessor creates AbortController → passes signal to `backend.chat()` → backend forwards signal to fetch/SDK.

---

## Manual Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC7.1 — `packages/discord/` deleted | Filesystem state assertion | Run `ls packages/ \| grep discord` and confirm no output. Run `bun test --recursive` and confirm no tests from `packages/discord/` are attempted. |
| AC7.2 — Build succeeds without `@bound/discord` | Build success requires the actual toolchain | Run `bun run build` and confirm exit code 0. Run the grep from Phase 6 Step 6.2 to confirm no `@bound/discord` references remain. |
| AC4.3 — Remote scheduler fires event-driven task (partial) | Integration test validates relay delivery and eventBus emission but does not fully exercise the Scheduler | Run `bun test packages/sync/src/__tests__/event-broadcast.integration.test.ts` and confirm AC4.3 passes. If flaky due to timing, increase `setTimeout` wait from 200ms to 500ms. |

---

## Traceability

| Criterion | Automated Test | Manual Step |
|-----------|----------------|-------------|
| AC1.1 | `schema.test.ts` "AC1.1: users table has platform_ids" | Phase 1 Step 1.1 |
| AC1.2 | `schema.test.ts` "AC1.2: existing discord_id rows migrated" | Phase 1 Step 1.1 |
| AC1.3 | `schema.test.ts` "AC1.3: discord_id column not exist" | Phase 1 Step 1.1 |
| AC1.4 | `schema.test.ts` "AC1.4: hosts table has platforms" | Phase 1 Step 1.1 |
| AC1.5 | `schema.test.ts` "AC1.5: threads accepts telegram" | Phase 1 Step 1.1 |
| AC1.6 | `config-schemas.test.ts` "AC1.6: rejects discord_id" | Phase 1 Step 1.2 |
| AC1.7 | `config-schemas.test.ts` "AC1.7: accepts platforms.discord" | Phase 1 Step 1.2 |
| AC2.1 | `config-schemas.test.ts` "AC2.1: platformsSchema accepts" | Phase 1 Step 1.2 |
| AC2.2 | `config-schemas.test.ts` "AC2.2: rejects manual" | Phase 1 Step 1.2 |
| AC2.3 | `config-schemas.test.ts` "AC2.3: no discord.json" | Phase 1 Steps 1.2, 1.3 |
| AC2.4 | `config-schemas.test.ts` "AC2.4: discordSchema not exported" | Phase 1 Steps 1.2, 1.3 |
| AC3.1 | `config-schemas.test.ts` "AC3.1: RELAY_REQUEST_KINDS" (3 tests) | Phase 1 Step 1.2 |
| AC3.2 | `relay-processor.test.ts` "AC3.2: duplicate intake discarded" | Phase 2 Step 2.1 |
| AC3.3 | `relay-processor.test.ts` "AC3.3: thread affinity routing" | Phase 2 Step 2.1 |
| AC3.3 (integration) | `intake-pipeline.integration.test.ts` "AC3.3" | Phase 3 Step 3.4 |
| AC3.4 | `relay-processor.test.ts` "AC3.4: model match routing" | Phase 2 Step 2.1 |
| AC3.5 | `relay-processor.test.ts` "AC3.5: tool match routing" | Phase 2 Step 2.1 |
| AC3.6 | `relay-processor.test.ts` "AC3.6: least-loaded fallback" | Phase 2 Step 2.1 |
| AC3.7 | `relay-processor.test.ts` "AC3.7: platform_deliver emits" | Phase 2 Step 2.1 |
| AC3.7 (integration) | `intake-pipeline.integration.test.ts` "AC3.7" | Phase 3 Step 3.4 |
| AC3.8 | `relay-processor.test.ts` "AC3.8: event_broadcast fires" | Phase 2 Step 2.1 |
| AC3.9 | `multi-instance.integration.test.ts` "AC3.9: broadcast" (2 tests) | Phase 2 Step 2.2 |
| AC4.1 | `emit.test.ts` "AC4.1: writes event_broadcast" | Phase 4 Step 4.1 |
| AC4.2 | `emit.test.ts` "AC4.2: no relay without hub" | Phase 4 Step 4.1 |
| AC4.3 | `event-broadcast.integration.test.ts` "AC4.3" | Phase 2 Step 2.3 |
| AC4.4 | `relay-processor.test.ts` "AC4.4: event_depth propagation" | Phase 2 Step 2.1 |
| AC5.1 | `leader-election.test.ts` "AC5.1: claims leadership" | Phase 3 Step 3.1 |
| AC5.2 | `leader-election.test.ts` "AC5.2: enters standby" | Phase 3 Step 3.1 |
| AC5.3 | `leader-election.test.ts` "AC5.3: promotes when stale" | Phase 3 Step 3.1 |
| AC5.4 | `leader-election.test.ts` "AC5.4: heartbeat writes" | Phase 3 Step 3.1 |
| AC5.5 | `registry.test.ts` "AC5.5: routes platform:deliver" | Phase 3 Step 3.2 |
| AC5.6 | `registry.test.ts` "AC5.6: delivery = exclusive" | Phase 3 Step 3.2 |
| AC5.7 | `registry.test.ts` "AC5.7: deliver() throws" | Phase 3 Step 3.2 |
| AC6.1 | `discord-connector.test.ts` "AC6.1: writes intake relay" | Phase 3 Step 3.3 |
| AC6.2 | `discord-connector.test.ts` "AC6.2: persists via insertRow" | Phase 3 Step 3.3 |
| AC6.3 | `discord-connector.test.ts` "AC6.3: chunks at 2000 chars" | Phase 3 Step 3.3 |
| AC6.4 | `discord-connector.test.ts` "AC6.4: no shouldActivate" | Phase 3 Step 3.3 |
| AC6.5 | `discord-connector.test.ts` "AC6.5: allowlist check" | Phase 3 Step 3.3 |
| AC7.1 | N/A (filesystem assertion) | Phase 6 Step 6.1 |
| AC7.2 | N/A (build verification) | Phase 6 Steps 6.2, 6.3 |
| AC7.3 | `webhooks.test.ts` "AC7.3: POST /discord" | Phase 4 Step 4.2 |
| AC8.1 | `anthropic-driver.test.ts` "AC8.1: passes signal" | Phase 5 Step 5.1 |
| AC8.2 | `bedrock-driver.test.ts` "AC8.2: passes signal" | Phase 5 Step 5.2 |
| AC8.3 | `openai-driver.test.ts` "AC8.3: passes signal" | Phase 5 Step 5.3 |
| AC8.4 | `ollama-driver.test.ts` "AC8.4: passes signal" | Phase 5 Step 5.4 |
| AC8.5 | `relay-processor.test.ts` "AC8.5: passes signal" | Phase 5 Step 5.5 |
