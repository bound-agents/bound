# Test Plan: Platform-Scoped Tools

**Implementation plan:** `docs/implementation-plans/2026-03-29-platform-scoped-tools/`
**HEAD SHA:** `46529a0`
**Coverage:** 18/18 acceptance criteria

---

## Prerequisites

- Working tree at `.worktrees/platform-scoped-tools/`
- Dependencies installed: `bun install`
- All automated tests passing:
  ```bash
  bun test packages/platforms packages/agent
  ```
- Full typecheck passing: `bun run typecheck`

---

## Phase 1: Discord Tool Validation (AC1, AC2)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | `bun test packages/platforms/src/__tests__/discord-connector.test.ts` | All 29 tests pass, including 8 under `getPlatformTools()` describe block |
| 1.2 | Inspect AC1.1 test: `result === "sent"` and `deliverCalled === true` | Pass with 0 failures |
| 1.3 | Inspect AC1.4 test: error string starts with `"Error"` and includes character count, deliver never called | Pass |
| 1.4 | Inspect AC1.2 attachment test: file read into `Buffer`, filename extracted from path, `attachments[0].filename` matches temp file name | Pass |

---

## Phase 2: Registry Lookup (AC4)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | `bun test packages/platforms/src/__tests__/registry.test.ts` | All 12 tests pass |
| 2.2 | Verify `getConnector("webhook-stub")` returns instance with `platform === "webhook-stub"` | Test passes |
| 2.3 | Verify `getConnector("nonexistent")` returns `undefined` | Test passes |

---

## Phase 3: Context Assembly (AC5)

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | `bun test packages/agent/src/__tests__/context-assembly.test.ts` | All 19 tests pass |
| 3.2 | Verify AC5.1: system message includes `discord_send_message` and silence semantics matching `/sees nothing\|silence\|cannot see/i` | Test at line 1230 passes |
| 3.3 | Verify AC5.2: no system message references `discord_send_message` when `platformContext` is absent | Test at line 1250 passes |

---

## Phase 4: Agent Loop Dispatch (AC3)

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | `bun test packages/agent/src/__tests__/agent-loop.test.ts` | All 21 tests pass |
| 4.2 | Verify AC3.1: LLM calls `discord_send_message`, platform tool `execute()` invoked (`platformToolExecuted === true`), sandbox NOT called (`mockBash.calls.length === 0`) | Pass |
| 4.3 | Verify AC3.2: LLM calls `bash` (not in `platformTools`), sandbox IS called (`mockBash.calls.length === 1`) | Pass |

---

## Phase 5: Relay Processor Wiring (AC6)

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | `bun test packages/agent/src/__tests__/relay-processor.test.ts` | All 31 tests pass |
| 5.2 | Verify AC6.1: `executeProcess` with registry wires `platform === "discord"` and `platformTools` map into `AgentLoopConfig` | `capturedLoopConfig.platform === "discord"`, `platformTools.has("discord_send_message") === true` |
| 5.3 | Verify AC6.2: `executeProcess` with `platform: "discord"` suppresses `platform:deliver` event | `platformDeliverEmitted === false` |
| 5.4 | Verify AC6.3: `executeProcess` with `platform: null` emits `platform:deliver` with correct payload | `platformDeliverPayload.platform === "discord"`, content matches assistant message |
| 5.5 | Verify AC6.4: no registry set, process relay with `platform: "discord"`, no crash, no tools injected | `capturedLoopConfig.platformTools === undefined`, test completes |

---

## End-to-End: Full Platform Tool Lifecycle

**Purpose:** Validates the entire flow from platform context injection through tool dispatch to delivery suppression works as an integrated chain.

1. Run the full test suite: `bun test packages/platforms packages/agent`
2. Confirm total test count is stable (expected: 62 tests across 4 test files)
3. Run `bun test --recursive` to confirm no regressions in other packages
4. Run `bun run typecheck` to verify all interface contracts compile cleanly

---

## End-to-End: Negative Path -- Registry Absence

**Purpose:** Validates graceful degradation when platform infrastructure is not configured.

1. `bun test packages/agent/src/__tests__/relay-processor.test.ts --test-name-pattern "gracefully proceeds"`
2. Confirm `capturedLoopConfig.platform === undefined` and `capturedLoopConfig.platformTools === undefined`
3. Proves the system does not crash when `setPlatformConnectorRegistry()` is never called

---

## Traceability Matrix

| Acceptance Criterion | Automated Test | Manual Step |
|---|---|---|
| AC1.1: Valid content delivers and returns "sent" | `discord-connector.test.ts` line 795 | Step 1.2 |
| AC1.2: Attachment path loads buffer into deliver() | `discord-connector.test.ts` line 874 | Step 1.4 |
| AC1.3: Sequential executes invoke deliver separately | `discord-connector.test.ts` line 946 | Step 1.1 |
| AC1.4: Over 2000 chars returns error, no delivery | `discord-connector.test.ts` line 855 | Step 1.3 |
| AC1.5: Bad attachment path returns error, no delivery | `discord-connector.test.ts` line 923 | Step 1.1 |
| AC1.6: Exactly 2000 chars succeeds | `discord-connector.test.ts` line 825 | Step 1.1 |
| AC2.1: getPlatformTools returns correct tool definition | `discord-connector.test.ts` line 740 | Step 1.1 |
| AC2.2: Execute closure bound to correct threadId | `discord-connector.test.ts` line 753 | Step 1.1 |
| AC3.1: Platform tool dispatch bypasses sandbox | `agent-loop.test.ts` line 908 | Step 4.2 |
| AC3.2: Non-platform tool falls through to sandbox | `agent-loop.test.ts` line 964 | Step 4.3 |
| AC4.1: getConnector returns registered connector | `registry.test.ts` line 332 | Step 2.2 |
| AC4.2: getConnector returns undefined for unknown | `registry.test.ts` line 354 | Step 2.3 |
| AC5.1: Platform system message injected | `context-assembly.test.ts` line 1230 | Step 3.2 |
| AC5.2: No platform message without platformContext | `context-assembly.test.ts` line 1250 | Step 3.3 |
| AC6.1: executeProcess wires platform tools into config | `relay-processor.test.ts` line 2477 | Step 5.2 |
| AC6.2: Platform context suppresses auto-deliver | `relay-processor.test.ts` line 2634 | Step 5.3 |
| AC6.3: Null platform fires auto-deliver normally | `relay-processor.test.ts` line 2759 | Step 5.4 |
| AC6.4: No registry gracefully degrades | `relay-processor.test.ts` line 2889 | Step 5.5 |
