# Test Requirements Matrix

Maps each acceptance criterion from the system architecture design plan to specific automated tests or documented human verification procedures.

**Source:** `docs/design-plans/2026-03-21-system-arch.md` (AC1-AC4)
**Implementation plans:** `docs/implementation-plans/2026-03-21-system-arch/phase_01.md` through `phase_08.md`

---

## AC1: Implementation architecture is documented with clear module boundaries

| ID | Criterion | Test Type | Test File Path | Automated? | Notes |
|----|-----------|-----------|----------------|------------|-------|
| AC1.1 | 9 packages exist with correct dependency graph -- no circular imports | Unit | `scripts/__tests__/dependency-graph.test.ts` | Yes | Run `tsc --noEmit` across all packages (Phase 7, Task 5 build pipeline). Additionally, write a test that parses each package.json `dependencies` field and asserts no cycles exist in the workspace dependency graph. Verify exactly 9 `@bound/*` packages are present: shared, core, llm, sandbox, agent, sync, web, discord, cli. |
| AC1.2 | Each package has well-defined responsibility documented in package.json description | Unit | `scripts/__tests__/package-descriptions.test.ts` | Yes | Iterate over all 9 `packages/*/package.json` files, assert each has a non-empty `description` field, and assert each description is unique (no two packages share the same description). Phase 1 Task 2 defines the first descriptions; subsequent phases add the remaining 7. |
| AC1.3 | DI container resolves all services at startup without runtime errors | Integration | `packages/core/src/__tests__/container.test.ts` | Yes | Phase 1 Task 9: call `bootstrapContainer()` with valid config and temp DB, resolve every registered service, verify all are singletons (resolving twice returns same instance), verify no runtime errors during resolution. |
| AC1.4 | Typed event bus delivers events across package boundaries | Unit | `packages/shared/src/__tests__/event-emitter.test.ts` | Yes | Phase 1 Task 3: register a listener for `message:created` on `TypedEventEmitter`, emit the event, verify listener receives correctly-typed payload. Also test `on`, `off`, `once`, and verify events do not leak across unrelated event names. |
| AC1.5 | Circular dependency causes build error | Unit | `scripts/__tests__/dependency-graph.test.ts` | Yes | Phase 7 Task 5: run `tsc --noEmit` as part of the build pipeline and verify it succeeds. The dependency graph test (AC1.1) programmatically detects cycles by walking package.json dependencies. A separate negative test should introduce a synthetic circular import in a temp workspace and verify that `tsc` fails. |
| AC1.6 | Optional packages can be disabled without affecting core | Integration | `packages/cli/src/__tests__/start.test.ts` | Yes | Phase 7 Task 3 / Task 6: bootstrap the orchestrator without `discord.json` or `sync.json` present in the config directory. Verify: web server starts and responds to `/api/status`, agent loop processes a message, no errors logged about missing optional packages. Separately: remove discord and sync from the bootstrap config and verify all core tests pass. |

---

## AC2: Technology stack is confirmed with specific libraries

| ID | Criterion | Test Type | Test File Path | Automated? | Notes |
|----|-----------|-----------|----------------|------------|-------|
| AC2.1 | Hono serves HTTP API routes and static Svelte assets from a single Bun.serve call | Integration | `packages/web/src/server/__tests__/integration.test.ts` | Yes | Phase 5 Task 5: start the web server, verify `GET /api/status` returns JSON, verify `GET /` returns the Svelte SPA HTML, verify both are served from a single `Bun.serve` invocation (one port, one server handle). |
| AC2.2 | Bun.serve native WebSocket pushes new messages to connected browser clients | Integration | `packages/web/src/server/__tests__/websocket.test.ts` | Yes | Phase 5 Task 3: connect a WebSocket client to `/ws`, subscribe to a thread, emit `message:created` on the EventBus, verify the WebSocket client receives the message data. Test multiple clients with different subscriptions receiving only their updates. |
| AC2.3 | bun:sqlite creates database with WAL mode and all 13 STRICT tables | Integration | `packages/core/src/__tests__/schema.test.ts` | Yes | Phase 1 Task 6: create a database at a temp path, run `applySchema()`, query `sqlite_master` to verify all 13 tables exist, query `PRAGMA journal_mode` to verify it returns `'wal'`, attempt an INSERT with a wrong type into a STRICT table and verify it fails, query `sqlite_master WHERE type='index'` to verify all expected indexes exist. |
| AC2.4 | just-bash sandbox executes defineCommands, returns stdout/stderr/exitCode, persists filesystem changes | Integration | `packages/sandbox/src/__tests__/integration.test.ts` | Yes | Phase 3 Task 8: full sandbox lifecycle -- create temp DB with schema and seed files, create ClusterFs and hydrate from DB, register a test defineCommand, create sandbox via factory, exec commands (write file, read file, use defineCommand, pipe output), diff workspace, persist via OCC, verify files in DB match sandbox state and change_log entries exist. Also tested in `packages/sandbox/src/__tests__/commands.test.ts` (Phase 3 Task 4) and `packages/sandbox/src/__tests__/sandbox-factory.test.ts`. |
| AC2.5 | Zod validates config files at startup, rejects malformed input with specific error messages | Unit | `packages/shared/src/__tests__/config-schemas.test.ts` | Yes | Phase 1 Task 4: valid `allowlist.json` and `model_backends.json` parse without errors with correctly typed fields. Missing required fields produce specific Zod validation errors with field paths and human-readable messages. Invalid values (negative `context_window`, `tier > 5`) produce validation errors. Cross-field validation tested (e.g., `default_web_user` referencing nonexistent user). |
| AC2.6 | Invalid config file produces clear validation error, not runtime crash | Unit + Integration | `packages/shared/src/__tests__/config-schemas.test.ts`, `packages/core/src/__tests__/config-loader.test.ts` | Yes | Phase 1 Tasks 4 and 8: write invalid config files (missing `backends` array, missing `default_web_user`) to a temp directory, load them via `loadRequiredConfigs()`, verify structured `ConfigError` objects are returned (not thrown exceptions) containing filename, message, and field-level errors. Verify missing required config files produce "file not found" errors, not crashes. |

---

## AC3: Phased build order produces working vertical slices

| ID | Criterion | Test Type | Test File Path | Automated? | Notes |
|----|-----------|-----------|----------------|------------|-------|
| AC3.1 | Phase 1 completes with runnable monorepo (bun install + bun test succeed) | Integration | `packages/core/src/__tests__/integration.test.ts` | Yes | Phase 1 Task 10: create temp directory with valid configs, call `createAppContext()`, verify DB has all 13 tables, insert a user via `insertRow()` and verify change_log entry, emit event and verify listener receives it, verify WAL mode active. The meta-verification is that `bun install && bun test --recursive` passes from root with zero failures. |
| AC3.2 | Phase 2 completes with two instances syncing on localhost | Integration | `packages/sync/src/__tests__/multi-instance.integration.test.ts` | Yes | Phase 2 Task 9: test harness spawns Instance A (hub, port 3100) and Instance B (spoke, port 3200) with real SQLite DBs in `/tmp/`. Runs all 7 sync scenarios (see AC4.4). Each test creates fresh instances, runs the scenario, asserts correctness on both databases, and cleans up. |
| AC3.3 | Phase 4 completes with full agent loop (user msg -> assistant response with tool execution) | Integration | `packages/agent/src/__tests__/integration.test.ts` | Yes | Phase 4 Task 7: create temp DB with schema, seed user and thread, bootstrap AppContext, create ClusterFs and sandbox, create mock LLMBackend that returns tool_use on first call and text on second call, run AgentLoop, verify: user message in DB, tool_call message in DB, tool_result message in DB, assistant response in DB, semantic_memory entry created, change_log entries for all writes, loop returned to IDLE with correct result counts. |
| AC3.4 | Phase 5 completes with browser-based chat UI at localhost:3000 | E2E | `e2e/web-chat.spec.ts` | Yes | Phase 5 Task 6: Playwright test navigates to `http://localhost:3000`, verifies System Map displayed, creates thread, opens Line View, types and submits message, verifies user message appears, waits for agent response (mock LLM), verifies assistant response appears, navigates back to System Map and verifies thread appears as metro line. Skippable via `SKIP_E2E=1`. |
| AC3.4 | (supplementary) | Integration | `packages/web/src/server/__tests__/integration.test.ts` | Yes | Phase 5 Task 5: start server, fetch `/api/status` and verify JSON, fetch `/` and verify HTML, fetch `/api/threads` and verify empty array. This provides a faster automated check than the full Playwright E2E. |
| AC3.5 | Phase 7 completes with bound init --ollama && bound start producing working system | Integration | `packages/cli/src/__tests__/e2e.integration.test.ts` | Yes | Phase 7 Task 6: create temp directory, run `bound init --ollama` and verify config files created, start orchestrator with mock LLM backend, poll `/api/status` until ready, verify `GET /api/threads` returns 200, create thread, send message, verify agent processes it, stop orchestrator and verify graceful shutdown. |
| AC3.6 | Each phase's tests pass independently | Integration | Per-phase test suites | Yes | Each phase's implementation plan defines tests that depend only on packages built in that phase and earlier phases. Verification: run `bun test packages/{package}/` for each package independently. A CI pipeline should run tests per-phase in order, verifying each passes before proceeding to the next. A dedicated test script can enforce this by running tests scoped to each phase's packages in sequence. |

---

## AC4: Testing strategy covers all packages

| ID | Criterion | Test Type | Test File Path | Automated? | Notes |
|----|-----------|-----------|----------------|------------|-------|
| AC4.1 | Every package has unit tests via bun test | Meta | `scripts/__tests__/test-coverage-check.test.ts` | Yes | Write a meta-test that iterates over all 9 `packages/*/` directories, verifies each contains at least one `*.test.ts` or `*.integration.test.ts` file, and runs `bun test packages/{name}/` to verify it exits with code 0. Phases 1-8 each add tests for their respective packages. |
| AC4.2 | Core, agent, sync have integration tests with real SQLite | Integration | `packages/core/src/__tests__/integration.test.ts`, `packages/agent/src/__tests__/integration.test.ts`, `packages/sync/src/__tests__/multi-instance.integration.test.ts` | Yes | Phase 1 Task 10 (core): full AppContext creation with real SQLite, insert/query/change_log verification. Phase 4 Task 7 (agent): full agent loop with real SQLite + mock LLM. Phase 2 Task 9 (sync): multi-instance test with two real SQLite databases. All integration tests use temp databases in `/tmp/bound-test-*` with cleanup. |
| AC4.3 | Sync integration tests run two instances on different ports | Integration | `packages/sync/src/__tests__/multi-instance.integration.test.ts` | Yes | Phase 2 Task 9: test harness creates Instance A ("laptop") at `/tmp/bound-test-a/bound.db`, port 3100, role hub, and Instance B ("cloud-vm") at `/tmp/bound-test-b/bound.db`, port 3200, role spoke. Both share a keyring with each other's Ed25519 public keys. Real HTTP between instances, real SQLite databases, no mocking. |
| AC4.4 | Multi-instance sync tests validate 7 scenarios | Integration | `packages/sync/src/__tests__/multi-instance.integration.test.ts` | Yes | Phase 2 Task 9: seven distinct test cases within the multi-instance integration test file. See table below for per-scenario breakdown. |
| AC4.5 | Playwright E2E tests verify web chat flow | E2E | `e2e/web-chat.spec.ts` | Yes | Phase 5 Task 6: Playwright test with chromium (headless). Navigates to localhost:3000, creates thread, sends message, verifies response, navigates back. Skippable via `SKIP_E2E=1`. Configuration in `e2e/playwright.config.ts`. |
| AC4.6 | Code coverage meets thresholds: 80% for core/agent/sync, 60% for web/discord/cli | Meta | `scripts/__tests__/coverage-thresholds.test.ts` | Yes | Phase 1 Task 1 defines global 60% floor in `bunfig.toml`. A CI script or meta-test should run `bun test --coverage` per package and parse the coverage output to verify: core, agent, sync each meet 80% line and function coverage; web, discord, cli each meet 60%. Shared and llm follow the 60% global floor. Per-package `bunfig.toml` overrides can enforce stricter thresholds for core/agent/sync. |
| AC4.7 | External service tests are skippable via env flag | Unit + Integration | `packages/llm/src/__tests__/integration.test.ts`, `packages/llm/src/__tests__/anthropic-driver.test.ts`, `packages/llm/src/__tests__/bedrock-driver.test.ts`, `packages/discord/src/__tests__/bot.test.ts`, `e2e/web-chat.spec.ts` | Yes | Phase 3 Task 8 (Ollama): skip via `SKIP_OLLAMA=1`. Phase 8 Task 1 (Anthropic): skip via `SKIP_ANTHROPIC=1`. Phase 8 Task 2 (Bedrock): skip via `SKIP_BEDROCK=1`. Phase 6 Task 2 (Discord): skip via `SKIP_DISCORD=1`. Phase 5 Task 6 (E2E): skip via `SKIP_E2E=1`. Verification: set all SKIP flags, run `bun test --recursive`, verify zero failures and skipped tests are reported. |

---

## AC4.4: Multi-instance sync scenario breakdown

Each scenario is a separate test case within `packages/sync/src/__tests__/multi-instance.integration.test.ts` (Phase 2 Task 9).

| # | Scenario | Assertions | Test File |
|---|----------|------------|-----------|
| 1 | Basic replication | Insert `semantic_memory` row on Instance A. Sync from Instance B. Assert Instance B has the same row with identical field values. | `multi-instance.integration.test.ts` |
| 2 | Bidirectional sync | Insert different rows on each instance. Sync from B to A. Assert both instances have all rows. | `multi-instance.integration.test.ts` |
| 3 | LWW conflict resolution | Insert same key on both instances with different values. Instance A's `modified_at` is 1 second later. Sync. Assert both instances have Instance A's value. | `multi-instance.integration.test.ts` |
| 4 | Append-only dedup | Insert a message with the same UUID on both instances. Sync both directions. Assert each instance has exactly one copy. | `multi-instance.integration.test.ts` |
| 5 | Change log pruning | Sync successfully. Prune on Instance A (all events confirmed by B). Assert pruned events deleted, new events still work, sync still works after pruning. | `multi-instance.integration.test.ts` |
| 6 | Reconnection catch-up | Make multiple changes on A while B is not syncing. Then sync B. Assert B has all changes and cursor tracks where B left off. | `multi-instance.integration.test.ts` |
| 7 | Hub promotion | Start with A as hub, B as spoke. Change `cluster_config.cluster_hub` to B. Sync. Assert B accepts push/pull requests and A can sync to B. | `multi-instance.integration.test.ts` |

---

## Supporting test files by package

Complete inventory of all test files referenced by the acceptance criteria, organized by package.

### @bound/shared

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/shared/src/__tests__/uuid.test.ts` | Unit | 1 | AC4.1 |
| `packages/shared/src/__tests__/event-emitter.test.ts` | Unit | 1 | AC1.4, AC4.1 |
| `packages/shared/src/__tests__/logger.test.ts` | Unit | 1 | AC4.1 |
| `packages/shared/src/__tests__/config-schemas.test.ts` | Unit | 1 | AC2.5, AC2.6, AC4.1 |
| `packages/shared/src/__tests__/result.test.ts` | Unit | 1 | AC4.1 |

### @bound/core

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/core/src/__tests__/schema.test.ts` | Integration | 1 | AC2.3, AC4.1 |
| `packages/core/src/__tests__/change-log.test.ts` | Integration | 1 | AC2.3, AC4.1 |
| `packages/core/src/__tests__/config-loader.test.ts` | Unit | 1 | AC2.5, AC2.6, AC4.1 |
| `packages/core/src/__tests__/container.test.ts` | Integration | 1 | AC1.3, AC4.1 |
| `packages/core/src/__tests__/integration.test.ts` | Integration | 1 | AC3.1, AC4.1, AC4.2 |
| `packages/core/src/__tests__/metrics.test.ts` | Integration | 8 | AC4.1 |

### @bound/sync

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/sync/src/__tests__/crypto.test.ts` | Unit | 2 | AC4.1 |
| `packages/sync/src/__tests__/signing.test.ts` | Unit | 2 | AC4.1 |
| `packages/sync/src/__tests__/reducers.test.ts` | Integration | 2 | AC4.4 (LWW, dedup) |
| `packages/sync/src/__tests__/changeset.test.ts` | Integration | 2 | AC4.4 (basic replication) |
| `packages/sync/src/__tests__/peer-cursor.test.ts` | Integration | 2 | AC4.1 |
| `packages/sync/src/__tests__/sync-loop.test.ts` | Unit | 2 | AC3.2, AC4.4 (catch-up) |
| `packages/sync/src/__tests__/routes.test.ts` | Integration | 2 | AC3.2, AC4.1 |
| `packages/sync/src/__tests__/pruning.test.ts` | Integration | 2 | AC4.4 (pruning) |
| `packages/sync/src/__tests__/multi-instance.integration.test.ts` | Integration | 2 | AC3.2, AC4.2, AC4.3, AC4.4 |

### @bound/sandbox

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/sandbox/src/__tests__/cluster-fs.test.ts` | Integration | 3 | AC2.4, AC4.1 |
| `packages/sandbox/src/__tests__/fs-persist.test.ts` | Integration | 3 | AC2.4, AC4.1 |
| `packages/sandbox/src/__tests__/commands.test.ts` | Integration | 3 | AC2.4, AC4.1 |
| `packages/sandbox/src/__tests__/sandbox-factory.test.ts` | Integration | 3 | AC2.4, AC4.1 |
| `packages/sandbox/src/__tests__/integration.test.ts` | Integration | 3 | AC2.4, AC4.1 |
| `packages/sandbox/src/__tests__/overlay-scanner.test.ts` | Integration | 8 | AC4.1 |

### @bound/llm

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/llm/src/__tests__/ollama-driver.test.ts` | Unit | 3 | AC4.1 |
| `packages/llm/src/__tests__/model-router.test.ts` | Unit | 3 | AC4.1 |
| `packages/llm/src/__tests__/integration.test.ts` | Integration | 3 | AC4.1, AC4.7 |
| `packages/llm/src/__tests__/anthropic-driver.test.ts` | Unit | 8 | AC4.1, AC4.7 |
| `packages/llm/src/__tests__/bedrock-driver.test.ts` | Unit | 8 | AC4.1, AC4.7 |
| `packages/llm/src/__tests__/openai-driver.test.ts` | Unit | 8 | AC4.1 |
| `packages/llm/src/__tests__/multi-provider.integration.test.ts` | Integration | 8 | AC4.1 |

### @bound/agent

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/agent/src/__tests__/agent-loop.test.ts` | Integration | 4 | AC3.3, AC4.1 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | Integration | 4 | AC3.3, AC4.1 |
| `packages/agent/src/__tests__/commands.test.ts` | Integration | 4 | AC3.3, AC4.1 |
| `packages/agent/src/__tests__/cache-commands.test.ts` | Integration | 4 | AC4.1 |
| `packages/agent/src/__tests__/scheduler.test.ts` | Integration | 4 | AC4.1 |
| `packages/agent/src/__tests__/task-resolution.test.ts` | Unit | 4 | AC4.1 |
| `packages/agent/src/__tests__/integration.test.ts` | Integration | 4 | AC3.3, AC4.1, AC4.2 |
| `packages/agent/src/__tests__/scheduler.integration.test.ts` | Integration | 4 | AC4.1 |
| `packages/agent/src/__tests__/mcp-bridge.test.ts` | Unit | 4 | AC4.1 |
| `packages/agent/src/__tests__/advisories.test.ts` | Integration | 8 | AC4.1 |
| `packages/agent/src/__tests__/redaction.test.ts` | Integration | 8 | AC4.1 |
| `packages/agent/src/__tests__/title-generation.test.ts` | Integration | 8 | AC4.1 |
| `packages/agent/src/__tests__/summary-extraction.test.ts` | Integration | 8 | AC4.1 |
| `packages/agent/src/__tests__/file-thread-tracker.test.ts` | Integration | 8 | AC4.1 |
| `packages/agent/src/__tests__/advanced-features.integration.test.ts` | Integration | 8 | AC4.1 |

### @bound/web

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/web/src/server/__tests__/routes.test.ts` | Integration | 5 | AC3.4, AC4.1 |
| `packages/web/src/server/__tests__/websocket.test.ts` | Integration | 5 | AC2.2, AC4.1 |
| `packages/web/src/client/__tests__/components.test.ts` | Unit | 5 | AC4.1 |
| `packages/web/src/server/__tests__/integration.test.ts` | Integration | 5 | AC2.1, AC3.4, AC4.1 |

### @bound/discord

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/discord/src/__tests__/allowlist.test.ts` | Unit | 6 | AC4.1 |
| `packages/discord/src/__tests__/bot.test.ts` | Unit | 6 | AC4.1, AC4.7 |
| `packages/discord/src/__tests__/thread-mapping.test.ts` | Integration | 6 | AC4.1 |
| `packages/discord/src/__tests__/integration.test.ts` | Integration | 6 | AC4.1 |

### @bound/cli

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `packages/cli/src/__tests__/init.test.ts` | Integration | 7 | AC3.5, AC4.1 |
| `packages/cli/src/__tests__/start.test.ts` | Integration | 7 | AC1.6, AC3.5, AC4.1 |
| `packages/cli/src/__tests__/boundctl.test.ts` | Integration | 7 | AC4.1 |
| `packages/cli/src/__tests__/e2e.integration.test.ts` | Integration | 7 | AC3.5, AC4.1 |

### E2E

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `e2e/web-chat.spec.ts` | E2E | 5 | AC3.4, AC4.5 |

### Meta / Scripts

| Test File | Test Type | Phase | Criteria Covered |
|-----------|-----------|-------|------------------|
| `scripts/__tests__/dependency-graph.test.ts` | Unit | 7 | AC1.1, AC1.5 |
| `scripts/__tests__/package-descriptions.test.ts` | Unit | 7 | AC1.2 |
| `scripts/__tests__/build.test.ts` | Integration | 7 | AC3.5 |
| `scripts/__tests__/test-coverage-check.test.ts` | Meta | 7 | AC4.1 |
| `scripts/__tests__/coverage-thresholds.test.ts` | Meta | 7 | AC4.6 |

---

## Summary

| Category | Total Criteria | Automated | Human Verification |
|----------|---------------|-----------|-------------------|
| AC1: Module boundaries | 6 | 6 | 0 |
| AC2: Technology stack | 6 | 6 | 0 |
| AC3: Phased build order | 6 | 6 | 0 |
| AC4: Testing strategy | 7 | 7 | 0 |
| **Total** | **25** | **25** | **0** |

All 25 acceptance criteria are covered by automated tests. No human verification is required.

---

## Environment flags for skippable tests

Tests that depend on external services can be skipped by setting these environment variables:

| Flag | Effect |
|------|--------|
| `SKIP_OLLAMA=1` | Skip tests requiring a running Ollama server |
| `SKIP_ANTHROPIC=1` | Skip tests requiring an Anthropic API key |
| `SKIP_BEDROCK=1` | Skip tests requiring AWS Bedrock credentials |
| `SKIP_DISCORD=1` | Skip tests requiring a Discord bot token |
| `SKIP_E2E=1` | Skip Playwright browser-based E2E tests |

Setting all flags simultaneously must result in zero test failures -- all skipped tests should be reported as skipped, not failed.
