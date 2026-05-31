# Contributing to Bound

Last verified: 2026-05-25

Thanks for your interest in contributing! This document is the developer-facing companion to [README.md](README.md) — if you're running `bun test` and touching SQL, this is the file you want.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend for end-to-end testing (Ollama works offline; Bedrock/Anthropic/OpenAI-compatible also supported)
- For Playwright e2e: system dependencies per `bun run test:e2e` output

## Setup

```bash
git clone https://github.com/karashiiro/bound.git
cd bound
bun install
```

First run (pick whichever LLM backend you have credentials for):

```bash
bun run packages/cli/src/bound.ts init --ollama
bun run packages/cli/src/bound.ts start
```

Open http://localhost:3001 for the web UI. The sync protocol listens on 3000.

## Commands

```bash
# Tests
bun test --recursive                                 # All packages
bun test packages/core                               # One package
bun test packages/core/src/__tests__/schema.test.ts  # Single file
bun test --test-name-pattern "pattern"               # Filter by name
bun run test:e2e                                     # Playwright e2e

# Lint / format (biome)
bun run lint
bun run lint:fix

# Typecheck (per-package — no composite mode at root)
tsc -p packages/shared --noEmit
bun run typecheck                                    # All packages sequentially

# Build (produces binaries in dist/)
bun run build
```

## Repo Layout

12 packages in a Bun workspace monorepo. Detailed dependency graph and per-package responsibilities live in [docs/design/architecture.md](docs/design/architecture.md).

Top-level:

```
packages/
  shared/       Types, events, Result<T,E>, Zod config schemas, HLC
  core/         SQLite schema, DI container, change-log outbox, relay CRUD
  sync/         Ed25519 WS sync, XChaCha20 encryption, LWW/append reducers
  sandbox/      Virtual filesystem (InMemoryFs/ClusterFs), command framework
  llm/          Driver shims (Bedrock, OpenAI-compatible) over Vercel AI SDK
  agent/        Agent loop, 8-stage context pipeline, commands, scheduler, MCP bridge
  platforms/    MCP-based platform connectors (Discord), connector handles, connector tool
  web/          Hono API + Svelte 5 SPA
  client/       BoundClient (HTTP + WS) for external consumers
  mcp-server/   Standalone stdio MCP server (bound-mcp)
  less/         Terminal coding agent client (boundless)
  cli/          bound/boundctl/bound-mcp/boundless binaries
```

For design rationale per package, see `docs/design/` — six topic files covering core infrastructure, sync protocol, agent system, sandbox+LLM, web+platforms, and the top-level architecture overview.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript 6.x (strict, ES2022, bundler module resolution)
- **Database**: `bun:sqlite` in WAL mode with STRICT tables
- **DI**: tsyringe + reflect-metadata (decorator-based singletons, setter injection)
- **Validation**: Zod v4
- **Web**: Hono (server) + Svelte 5 (client, Vite build)
- **Linting**: Biome (tabs, double quotes, semicolons, 100-char lines)
- **Testing**: `bun:test`, Playwright for e2e, `fast-check` for property-based tests (currently used only for the R-VC25 stable-prefix purity properties in `packages/agent/src/stable-prefix/__tests__/`)

## Testing Conventions

- **Unit tests**: `*.test.ts` — alongside the code they cover (or under `__tests__/`)
- **Integration tests**: `*.integration.test.ts`
- **Runner**: `bun:test` (`describe` / `it` / `expect`)
- **Coverage targets**: core/agent/sync/platforms 80%, web/cli 60%
- **Test DBs**: use temp paths with `randomBytes(4).toString("hex")` to avoid collisions
- **Multi-instance sync tests**: use random ports AND a unique `testRunId` per test. Without both, you'll hit `EADDRINUSE` or cross-test state bleed.
- **Mock LLM**: implement the `LLMBackend` interface with `setTextResponse()` / `setToolThenTextResponse()` — see existing tests in `packages/agent`.
- **Typecheck in tests**: the typecheck config excludes `__tests__/` directories, so missing fields on test-only fixtures can be silent. Mirror production shapes precisely when constructing `StreamChunk.done.usage` etc.

**Behavioral probes.** Tests under `packages/agent/src/__tests__/probes/` exercise real LLM drivers and consume inference budget. They are gated behind `BOUND_RUN_BEHAVIORAL_PROBE=1` and run on a separate cadence (weekly via the behavioral-probe workflow) rather than per-PR. Per-PR CI skips them. See `docs/test-plans/2026-05-22-volatile-context-probe.md` for the §8.6 procedure and operator workflow setup instructions.

## Critical Invariants

These rules exist because violating them has historically caused real production incidents (sync loss, SQL injection risk, cache misses, hot loops). Read each one before writing code that touches the subject.

### Database writes

**1. Change-log outbox pattern.** All writes to synced tables MUST use `insertRow()`, `updateRow()`, or `softDelete()` from `@bound/core` (`packages/core/src/change-log.ts`). Never write directly to a synced table with raw SQL. Synced tables are:

```
users, threads, messages, semantic_memory, tasks, files, hosts,
overlay_index, cluster_config, advisories, skills, memory_edges,
connector_handles, webhooks, turns, client_sessions
```

The source-of-truth type is `SyncedTableName` in `packages/shared/src/types.ts`. Writes bypassing the outbox never generate a `change_log` entry, so other hosts never learn about them.

**2. Soft deletes only.** Synced tables use a `deleted = 0|1` column. Never physically `DELETE` rows — use `softDelete()`.

**3. Relay tables are local-only.** `relay_outbox`, `relay_inbox`, `relay_cycles` do NOT use the change-log outbox. Use the dedicated CRUD helpers (`writeOutbox`, `insertInbox`, …) from `@bound/core`.

**4. Column-name validation.** Any SQL that interpolates a column name MUST pass it through `validateColumnName()` (regex `/^[a-z_]+$/`). Values always use parameterized queries. This applies to change-log replay, restore, reducers — anywhere JSON row data could drive column selection.

**20. No foreign key constraints on synced tables.** Synced tables must NOT declare `REFERENCES` / `FOREIGN KEY` constraints. `PRAGMA foreign_keys = ON` is set, but no synced table uses FK clauses. This is intentional: changelog replay, snapshot seeding, and backfill all insert rows in non-deterministic order — a message may arrive before its parent thread, a memory edge before its source node. FK constraints would cause intermittent hard failures during sync that depend on network timing. Referential integrity is enforced by the application write path (outbox helpers), not by the database engine during replay.

### Section A: Documented Narrow Exceptions to Invariant #1 (outbox pattern)

The outbox is mandatory for all writes to synced tables EXCEPT for the explicitly-justified
per-host hint columns listed below. Each exception is local-relevance-only with no cross-host
correctness invariant, and routing through `updateRow` would either cascade into stale-child
detection (advancing `modified_at`) or generate wasteful change-log volume for a signal other
hosts ignore. Do not extend this list without writing down the same justification.

- **`semantic_memory.last_accessed_at`**, bumped by `bumpRenderedDetailEntries` in
  `packages/agent/src/summary-extraction.ts` from `buildVolatileContext` on every cold
  assembly (debounced 1h per entry). Justified because (a) per-host relevance hint with no
  cross-host correctness invariant, (b) routing through `updateRow` would advance
  `modified_at` along with it, cascading into `buildStaleChildrenMap` and misclassifying
  every actively-rendered detail entry as stale, and (c) per-cold-assembly bumps would
  generate wasteful change-log volume for a signal other hosts ignore.

- **`tasks` bootstrap reset** (`packages/cli/src/commands/start/bootstrap.ts:62`), scoped to
  `claimed_by = ?siteId` per R-LR10. Justified because (a) per-host crash recovery on startup,
  (b) the reset reclaims rows owned by the booting host that were left mid-`running` from a
  prior crash, (c) routing through `outbox` would either (i) emit a change_log entry per
  crash-recovered task on every startup (potentially hundreds), polluting the cross-host log
  with site-local recovery noise, or (ii) require synthesizing a synthetic siteId before
  AppContext is fully bootstrapped. The R-LR10 scope predicate (`claimed_by = ?siteId`)
  makes this safe: each booting host only resets its own claims. Peer hosts handle
  peer-claimed stale rows via R-LR2's host-liveness eviction (Phase 4).

The PR review gate (R-LR6) blocks new `// outbox-exempt` annotations on synced-table writes
unless the new exemption is added to this list with the same justification format, OR the
write is on a non-synced table (category c below), OR the annotation is `// outbox-routed`
(asserting an explicit `createChangeLogEntry` follow-up in the same transaction).

### Audit Disposition Table for `outbox-exempt` Annotations

This table is an exhaustive snapshot of every `outbox-exempt` annotation in the repo as of
2026-05-26 (RFC `2026-05-26-task-lifecycle-resilience.md` close). Categories per R-LR12:
- **(a) justified-and-documented exception** — listed in the section above
- **(b) fixed by this RFC** — annotation removed or rewritten by R-LR1, R-LR3, R-LR5, or R-LR11
- **(c) non-synced table** — write target is NOT in `SyncedTableName`
- **(d) known-deferred** — synced-table write not fixed by this RFC; recorded with TODO link
- **(e) comment-only** — text mentioning "outbox-exempt" that's not an active annotation

The CI gate at `scripts/validate-outbox-invariant.ts` cross-checks new annotations against
this table.

| File:Line | Write target | Category | Disposition |
|-----------|-------------|----------|-------------|
| packages/agent/src/summary-extraction.ts:1707 | semantic_memory.last_accessed_at | (a) justified | Per-host relevance hint; see Section A above. |
| packages/agent/src/scheduler.ts:549 (REMOVED) | tasks.heartbeat_at | (b) fixed | R-LR1 routed timer-driven heartbeat refresh through outbox. |
| packages/agent/src/scheduler.ts:1226 (REMOVED) | tasks.heartbeat_at | (b) fixed | R-LR1 routed activity-driven heartbeat refresh through outbox. |
| packages/agent/src/scheduler.ts:311 (REMOVED) | tasks.next_run_at, tasks.status | (b) fixed | R-LR11 routed rescheduleHeartbeat through outbox. |
| packages/agent/src/scheduler.ts:915 (REWRITTEN) | tasks (status, claimed_by, claimed_at) | (b) fixed | R-LR5 rewrote to outbox-routed annotation; explicit createChangeLogEntry follows. |
| packages/agent/src/scheduler.ts:1005 (REWRITTEN) | tasks (status, lease_id, heartbeat_at) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/agent/src/scheduler.ts:1343 (REWRITTEN) | tasks (running → failed, model-validation) | (b) fixed | R-LR5 rewrote to outbox-routed annotation; R-LR3 added lease CAS guard. |
| packages/agent/src/scheduler.ts:1517 (REWRITTEN) | tasks (running → failed, soft-error) | (b) fixed | R-LR5 rewrote; R-LR3 added lease CAS guard. |
| packages/agent/src/scheduler.ts:1673 (REWRITTEN) | tasks (running → failed, hard-error) | (b) fixed | R-LR5 rewrote; R-LR3 added lease CAS guard. |
| packages/agent/src/scheduler.ts:1796 (REWRITTEN) | tasks (post-eviction reclaim) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/cli/src/commands/start/bootstrap.ts:62 | tasks (status, lease_id, claimed_by, claimed_at) | (a) justified | Per-host crash recovery scoped to claimed_by = ?siteId; see Section A above. |
| packages/cli/src/commands/start/bootstrap.ts:368 (REWRITTEN) | hosts (registration) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/cli/src/commands/start/bootstrap.ts:391 (REWRITTEN) | hosts (INSERT) | (b) fixed | R-LR5 rewrote to outbox-routed annotation. |
| packages/platforms/src/leader-election.ts:73 (REWRITTEN) | cluster_config (leader election) | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/drain.ts:42, 46, 83, 87, 101 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/set-hub.ts:125, 129 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/config-reload.ts:69, 73 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/cli/src/commands/stop-resume.ts:33, 37, 66 (REWRITTEN) | cluster_config | (b) fixed | R-LR5 rewrote. |
| packages/core/src/relay-metrics.ts:48 | turns.relay_target, turns.relay_latency_ms | (d) known-deferred | Synced-table write not fixed by this RFC. `turns` is synced; these columns are local-only instrumentation. TODO: follow-up RFC to either route through outbox or formalize as a Section A exception. |
| packages/sandbox/src/overlay-scanner.ts:128, 149, 170 | overlay_index (INSERT, UPDATE, soft-delete) | (d) known-deferred | `overlay_index` IS synced. Annotation says "outbox not provided (backward compat)". TODO: follow-up RFC to convert these to `insertRow`/`updateRow`/`softDelete`. |
| packages/agent/src/task-resolution.ts:428 | tasks.no_history | (d) known-deferred | Active legacy migration that runs on startup. TODO: follow-up RFC to route through outbox or formalize as a Section A exception. |
| packages/agent/scripts/agent-harness/driver.ts:51 | (none — comment-only) | (e) comment-only | Reference / educational note. |
| packages/agent/scripts/agent-harness/driver.ts:233 | (none — comment-only) | (e) comment-only | Reference / educational note. |
| packages/agent/src/validation/run-stable-prefix-drift-validation.ts:219 | (none — comment-only) | (e) comment-only | Reference to `bumpRenderedDetailEntries` exception. |

### Consistency and events

**5. OCC filesystem.** Compare hash-to-hash (never hash vs raw content). Persist inside `BEGIN IMMEDIATE`. Emit `file:changed` events AFTER the commit, never during.

**6. Events after commit.** `file:changed`, `changelog:written`, and similar events must fire AFTER `db.exec("COMMIT")`. Emitting during the transaction can cause listeners to observe uncommitted state.

**7. Tool-message persistence.** Tool messages must be persisted immediately after each tool execution, before the next LLM call. Batching these persists has caused context drift and duplicate tool calls.

### Types and shapes

**8. `bun:sqlite .get()` returns `null`** (not `undefined`) when no row is found. Guard accordingly.

**9. LLM message roles diverge between layers.** Two distinct types:
- `MessageRole` in `@bound/shared` (DB + event bus): `user | assistant | system | developer | alert | tool_call | tool_result | purge`
- `LLMMessage.role` in `@bound/llm` (driver input): `user | assistant | system | tool_call | tool_result | developer | cache`

`developer` carries volatile context and MUST be merged into an adjacent user message by the driver/bridge — wrapped in `<system-context>...</system-context>`. Orphan developer-only inputs are dropped. `cache` is a zero-content marker that tells drivers to place a cache breakpoint on the preceding message.

**10. `LLMMessage.content` can be `string | ContentBlock[]`.** Code handling messages must account for both forms. String-only assumptions break image/tool-use content.

**11. Model-alias passthrough.** Never pass `payload.model` to `backend.chat()` from the relay processor — `payload.model` is a logical alias (e.g., `"opus"`) that differs from the provider-specific identifier (e.g., a Bedrock ARN). The backend already knows its configured model.

**12. Canonical edge relations.** `memory_edges.relation` must be one of 10 values in `CANONICAL_RELATIONS` (from `@bound/core/memory-relations.ts`): `related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes`. SQLite triggers enforce this. Use the `context` TEXT column for bespoke phrasing. `upsertEdge()` validates before write and throws `InvalidRelationError`.

**13. Config schemas are closed (strict mode).** Every schema in `configSchemaMap` in `packages/shared/src/config-schemas.ts` uses `.strict()`, so unknown keys fail parse loudly. `cronSchedulesSchema` is closed-by-shape via `.catchall(cronEntrySchema)`. **When adding a config field, declare it in the Zod schema first** — otherwise the loader rejects the file at startup.

**19. `role: "system"` is forbidden in the `messages` table.** It is reserved for the LLM driver layer (stable-prefix system prompt). Use `role: "developer"` for any injected system-generated context intended for the agent — notifications, wakeup context, interruption notices, retry nudges. Defense in depth: `insertRow()` throws on `role: "system"` at the write boundary, AND both sync reducers in `packages/sync/src/reducers.ts` reject + log on replay so a peer running pre-fix code cannot corrupt this node via changelog push. Historically, `resolveDelegationMessageId()` (notifications) and the client-tool-expiry injector wrote `role: "system"` rows that Stage 2.5 of context assembly silently dropped; the rows existed in the DB but the LLM never saw them. `readMessageMetadata()` / `writeMessageMetadata()` in `@bound/core` provide an opaque JSON property bag on `messages.metadata` for platform-specific state (e.g. Discord delivery-retry tombstones); keys follow a `<platform>_*` namespace convention and the field is invisible to the agent loop and context assembly.

### Inference routing

**14. Hub response-kind routing.** Response kinds (`stream_chunk`, `stream_end`, `result`, `error`, `status_forward`) targeting the hub itself must be inserted into `relay_inbox`, NOT sent through `executeImmediate()`. The executor only handles request kinds.

**15. Platform intake affinity.** `intake` relay with a `platform` field must route to the host with that platform connector, not the host with the best model. Without this, the agent lacks platform tools (e.g., `discord_send_message`).

**16. Extended-thinking routing.** `ChatParams.thinking` is a discriminated union; `ChatParams.effort` rides alongside. The Bedrock driver folds both into `providerOptions.bedrock.reasoningConfig`. Temperature is suppressed whenever `reasoningConfig` is set. Config lives in `model_backends.json` and must be mirrored in `inferenceRequestPayloadSchema` to forward over the relay.

**18. ProcessPayload.message_id must reference a real `messages` row.** When `handleThread()` (spoke side) delegates to a remote host, the `message_id` it forwards via `ProcessPayload` must exist in the `messages` table on the delegating host so the receiving host's `executeProcess()` can resolve it. User-message entries are safe because `enqueueMessage(db, messageId, threadId)` stores the real `messages.id` as `dispatch_queue.message_id`. **Notifications are the trap**: `enqueueNotification()` generates a synthetic UUID — the injected system message gets a fresh UUID in a separate `insertRow()` call. Historically the spoke forwarded the dispatch-queue id, the hub's lookup returned null, and the notification was silently dropped. Use `resolveDelegationMessageId()` in `packages/cli/src/commands/start/server.ts` — it injects notifications AND returns the id to forward. The receiving side no longer hard-rejects on missing rows (it warns and proceeds on thread state alone), but the spoke is still the source of truth and should always forward a real id.

**21. Client-session affinity wins over model-based delegation.** A `notify` / `introspect` wakeup can fire on any host (webhook ingestion and PR-watch tasks run hub-side; the dispatch fires `handleThread` wherever the notify was enqueued). But a thread with a live boundless / `BoundClient` WS session can only execute `client`-kind tools (`boundless_*`) on the host holding that connection — client tool calls defer over that host's local event bus and are unreachable cross-host. So the delegation decision in `packages/cli/src/commands/start/server.ts` consults the `client_sessions` table (synced, LWW) BEFORE model-based `getDelegationTarget()`: (1) a live session on another host → delegate there; (2) a live session on this host → run locally and suppress model delegation (otherwise an opus-backed boundless loop gets pulled to the hub and stripped of its client tools — issue #91); (3) no live session → fall back to model-based delegation. `getClientSessionDelegationTarget()` answers cases 1+3 (returns the remote `EligibleHost` or null), `hasLocalClientSession()` disambiguates case 2. Sessions are recorded on `thread:subscribe`, soft-deleted on `thread:unsubscribe` and on WS close, and a staleness window (`CLIENT_SESSION_HOST_STALE_MS`) guards against a host that died without a clean close. `client_sessions` must stay in `SYNCED_TABLE_NAMES` / `SNAPSHOT_TABLE_ORDER` so peers learn session locations.

### Shared-config → router hand-off

**17.** `toRouterConfig()` in `packages/cli/src/commands/start/inference.ts` is the single place that translates snake_case `ModelBackendsConfig` into the camelCase `BackendConfig` consumed by `createModelRouter`. Any new per-backend field (e.g., `thinking`, `effort`, `max_output_tokens`, `cache_ttl`) MUST be copied here or it silently never reaches the router. `ModelResolution.local` must also carry the field, and both agent-loop and relay-processor must propagate it. For `cache_ttl` specifically, `relay-processor.executeInference` deliberately reads from the local backend (`modelRouter.getCacheTtl(payload.model)`) rather than the payload, so spokes apply their own TTL preference rather than honoring a hub-set TTL for a model the spoke does not support. The same hand-off direction applies to **per-turn cost**: `relay-processor.executeInference` computes `cost_usd` from `appCtx.config.modelBackends.backends` (the hub's authoritative pricing) and stamps it onto the final `done` `StreamChunk`; the spoke's agent-loop happy-path `recordTurn` prefers `parsed.costUsdFromHub` over its own `calculateTurnCost(...)` so hub-only spokes (empty `backends: []`) don't write `cost_usd = 0` for every delegated turn. The local `calculateTurnCost` call remains as the fallback for non-delegated inference and for backward-compat with hubs on pre-fix code.

## Common Gotchas

Accumulated the hard way — check here before writing a bug report.

- **AI SDK `usage.inputTokens` is the SUMMED total, not non-cached input**: across both Bedrock and Anthropic providers, the AI SDK's `usage.inputTokens` aggregates `noCache + cacheRead + cacheWrite` into a single number. The non-cached portion (what AWS bills at the full input rate, matching CloudWatch's `InputTokenCount`) lives on `usage.inputTokenDetails.noCacheTokens`. `extractUsage` in `packages/llm/src/ai-sdk-bridge.ts` reads from `inputTokenDetails.noCacheTokens` first and falls back to `inputTokens` only when details are absent. This means `StreamChunk.done.usage.input_tokens` (and downstream `turns.tokens_in`) is non-cached only — the three fields `tokens_in`, `tokens_cache_read`, `tokens_cache_write` are independent, NOT components of the same total; the full wire prompt size is the sum of all three. The agent-loop's inflation EMA at `applyActualUsageToContextDebug` deliberately sums all three back into `actualTotalTokens` because cache reads + writes occupy wire bytes (they're discounted in pricing, not absent from the prompt). Pre-fix (commit `ae09084b`), `calculateTurnCost` double-charged the cached portion at the full input rate; real AWS cost was ~50% of what `turns.cost_usd` recorded for cache-heavy turns. Verified live via 7-day CloudWatch reconciliation: DB-derived `noCache = tokens_in_pre_fix - cache_read - cache_write` matched `InputTokenCount` within 0.4% on opus. Historical `turns.cost_usd` rows are not backfilled — they're recorded with the old semantic and self-correct as new turns land.
- **`global.fetch` pollution**: tests that mock `global.fetch` (e.g., Ollama driver tests) MUST save and restore it in `afterAll`, or sync integration tests start failing with mysterious network errors.
- **SQLite `datetime()` vs ISO 8601**: never compare `datetime('now', '-Nh hours')` (which returns `2026-03-28 22:23:33`, space-separated) against JS `toISOString()` timestamps (`2026-03-28T22:23:33.091Z`, `T`-separated). ASCII `T` > ASCII space, so all ISO dates appear "newer". Always compute cutoffs in JS: `new Date(Date.now() - N * 3600_000).toISOString()` and pass as a parameter.
- **Zod v4 `z.record`**: requires two arguments — `z.record(keySchema, valueSchema)`. Single-arg calls don't type-check.
- **Typecheck is per-package**: there is no composite mode at the root. Run `tsc -p packages/<name> --noEmit` or `bun run typecheck` (sequential).
- **`bun test packages/cli`** prints init-test stdout — use the exit code to check success, not `grep`.
- **Mixed positional + flag arg parsing** (in `commands.ts`): Only affects MCP bridge commands (the only commands still dispatched through bash). Native agent tools use structured JSON parameters, eliminating this class of bugs.
- **`loopContextStorage` (AsyncLocalStorage)**: exported from `@bound/sandbox`. Commands running inside the agent loop see `threadId` / `taskId` in context automatically. Commands invoked outside (e.g., boundctl) don't.
- **`bound-mcp` polling**: `polaris.bound_chat()` may return a prior turn's content if the new turn hasn't completed by poll time. The DB is ground truth — check the `messages` table directly when debugging.
- **bound CLI config dir**: defaults to `./config` (relative to cwd) and data to `./data`. Use `--config-dir` / `--data-dir` to override, or run from the directory where your config lives.
- **Stale binaries**: `bun run build && cp dist/bound* ~/.local/bin/` is the install step. Running a stale compiled binary in one shell while iterating on source in another has burned us repeatedly. Check `bound --version` if behavior doesn't match source.
- **Universal 256 KiB tool-result cap**: every tool result, regardless of `kind`, is bounded by `capToolResultContent` (from `@bound/shared/strings.ts`, `MAX_TOOL_RESULT_BYTES = 256 * 1024`) at two boundaries — the agent-loop dispatch return (covers platform/sandbox/builtin and the legacy fallback) and `handleToolResult` in `packages/web/src/server/websocket.ts` (covers WS-deferred client tools from boundless / bound-mcp / external `BoundClient` consumers). Truncation is middle-cut with the marker `[truncated N bytes from middle; tool result exceeded 262144-byte cap — re-run with a narrower scope or pipe through head/grep]`; the marker's byte width is subtracted from the half-budgets so the function is idempotent and the output is guaranteed ≤ cap. If a tool result looks like it's missing a chunk, grep for the marker — that's the cap firing, not a bug. Per-tool caps still run first; this is a backstop, not the primary ceiling.
- **`query` accepts PRAGMAs**: the agent `query` tool allows `SELECT` plus a small read-only PRAGMA allowlist (`table_info`, `index_list`, `foreign_key_list`, `integrity_check`, etc.; see `SAFE_PRAGMA_ALLOWLIST` in `packages/agent/src/tools/query.ts`). The `PRAGMA x = y` assignment form is rejected regardless of name. Anything else (INSERT/UPDATE/DELETE/ATTACH/unknown PRAGMA) errors out. `LIMIT 1000` is still auto-appended to SELECTs but skipped for PRAGMAs.
- **Thread `interface` tag**: POST `/api/threads` accepts an optional body `{ interface?: string }` (default `"web"`, regex `/^[a-z0-9-]+$/i`, ≤32 chars; 400 otherwise). The value lives in `threads.interface` and flows into the agent's volatile context as a platform tag. `isUserFacingInterface()` in `@bound/shared` (`packages/shared/src/interface-tags.ts`) is the single gate for "should the agent see `platform: <name>`?" — currently allows everything except `scheduler`, `mcp`, and `webhook` (the canonical exclusion list lives in the same module as `NON_USER_FACING_INTERFACES`, also used by the `POST /api/threads` and `POST /api/mcp/threads` color cycle to skip system-driven threads when picking the next palette color). Adding a new user-facing surface usually needs no code change beyond setting the tag on thread creation; adding a new system-driven surface means extending the filter. `BoundClient.createThread(options?: { interface?: string })` is the client-side counterpart — `boundless` sets `interface: "boundless"`.
- **Cross-provider `tool_use` portability (id and name)**: `tool_use.id` and `tool_use.name` values persist in the `messages` table and survive provider switches. Anthropic enforces `^[a-zA-Z0-9_-]+$` on `tool_use.id` and rejects the entire request when a historical id contains anything else; Bedrock Converse caps both `toolUseId` and `toolUse.name` at 64 chars and validates them against `[a-zA-Z0-9_.:-]+` and `[a-zA-Z0-9_-]{1,64}` respectively. Two pathologies have been observed in production:
   1. **Charset (Kimi/Moonshot fallback ids)**: the OpenAI-compatible path, where the AI SDK synthesizes ids from `function.name + index` when the upstream emits no explicit id, routinely produces ids of the shape `functions.<name>:<index>` containing `.` and `:`. When such a thread later routes to opus or Bedrock-Anthropic, the API returns `messages.N.content.M.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'` and the turn fails.
   2. **Length+charset (Kimi/Moonshot template-token leakage, thread `81bd5e8d` 2026-05-21)**: the same path occasionally streams Moonshot's own `<|tool_call_argument_begin|>` template token mid-stream as plain text, and the AI SDK collapses the entire template fragment into the synthesized `tool_use.id` and `tool_use.name`. Persisted ContentBlocks end up with 200+ char id and name fields containing `<`, `|`, `>`, `{`, `}`, `"`, spaces, etc. The next turn fails with 6 simultaneous Bedrock validation errors (`Member must have length less than or equal to 64`, `Member must satisfy regular expression pattern: …`) on both the `toolUse` and the matching `toolResult`. The thread cannot self-recover and the task cannot be restarted without losing state.

  **Fix:** universal sanitization in two layers, both deterministic and idempotent.
  - **Streaming boundary** (`mapChunks` in `packages/llm/src/ai-sdk-bridge.ts`): `tool-input-start` / `-delta` / `-end` events run their `id` and `name` through `sanitizeToolUseId` and `sanitizeToolName` (the latter from `stream-utils.ts`) before yielding the corresponding `tool_use_start` / `_args` / `_end` `StreamChunk`s. Fresh tool calls therefore land in the DB already wire-legal. A `logger.warn` fires only when length truncation occurs (`sanitized.length < input.length`); charset-only diffs are expected steady state for AI SDK fallback ids and would spam logs. Both `BedrockDriver` and `OpenAICompatibleDriver` pass `providerName` into `MapChunksOptions` so the warn log identifies which provider is leaking.
  - **Read boundary** (`toModelMessages` in the same file): same sanitization is re-applied at all four sites — assistant `tool_call`-role tool_use parts, inline assistant content tool_use parts, `tool_result.tool_use_id`, and the `toolNameById` index keys + values. Idempotent on freshly-sanitized data, but **the recovery mechanism for already-poisoned historical rows**: a thread that pre-dates this fix self-heals on the next assembly without manual DB surgery or task recreation. The original DB content is preserved for auditability — only the wire projection is rewritten.

  `sanitizeToolUseId` (`[a-zA-Z0-9_-]{1,64}`, exported alongside `MAX_TOOL_USE_ID_LENGTH`) and `sanitizeToolName` (`[a-zA-Z0-9_-]{1,64}` with `unknown` empty fallback) both target the strict subset across every supported provider's accepted charset and length cap, so universal sanitization is lossless on the wire and avoids per-provider branching. When adding a new id-bearing or name-bearing field at the bridge boundary, route it through these helpers too.

## Recurring Checklists

### Adding a new synced table

1. Declare the CREATE TABLE in `packages/core/src/schema.ts` (or `metrics-schema.ts` for observability tables) as a STRICT table with `deleted INTEGER NOT NULL DEFAULT 0` (if LWW) and `modified_at TEXT NOT NULL`.
2. Add the name to `SyncedTableName` and `TABLE_REDUCER_MAP` in `packages/shared/src/types.ts`.
3. If its primary key is not `id`, add an entry to `TABLE_PK_COLUMN` in `packages/core/src/change-log.ts`.
4. Decide the reducer (`lww` or `append-only`) — wiring lives in `packages/sync/src/reducers.ts`, keyed off `TABLE_REDUCER_MAP`.
5. Use only `insertRow` / `updateRow` / `softDelete` for writes — never raw SQL.
6. Add migration logic if upgrading existing deployments (see `metrics-schema.ts` for the `turns` INTEGER→TEXT id migration as a template).
7. Update `docs/design/sync-protocol.md` if the reducer behavior is non-obvious.
8. Add the table to `SYNCED_TABLE_NAMES` in `packages/core/src/schema-introspection.ts` so `getSyncedTableSchemas()` exposes its columns in the agent's stable-prefix `## Database Schema` block. Tables not listed there are invisible to the `query` command's schema hint.
9. Add the table to `SNAPSHOT_TABLE_ORDER` in `packages/sync/src/ws-transport.ts` — this list controls the order in which tables are seeded to new spoke nodes joining the cluster. Omission here causes silent data loss on new spokes (that table's data will never appear in snapshots).

### Adding a config field

1. Add the field to the Zod schema in `packages/shared/src/config-schemas.ts` (remember `.strict()` mode means you MUST declare it or startup breaks).
2. If the field propagates to the router, thread it through `toRouterConfig()` in `packages/cli/src/commands/start/inference.ts`.
3. If it forwards over the relay, mirror it in `inferenceRequestPayloadSchema`.
4. If it's per-backend, consider whether `BackendConfig`, `ModelResolution`, agent-loop, and relay-processor all need to know.
5. Update the config example in `README.md` if the field is user-facing.

### Adding an agent tool

1. Create `packages/agent/src/tools/<name>.ts` exporting a `create<Name>Tool(ctx: ToolContext): RegisteredTool` factory function.
2. Define a `ToolDefinition` with JSON schema parameters (flat params, proper types). The LLM receives structured JSON — no string parsing needed.
3. Implement the `execute` handler: `(input: Record<string, unknown>) => Promise<BuiltInToolResult>`. Access `ctx.db`, `ctx.siteId`, `ctx.eventBus`, etc. via the closure.
4. Register the factory in `packages/agent/src/tools/index.ts` by adding it to the `createAgentTools()` array.
5. Add unit tests under `packages/agent/src/tools/__tests__/` — use real temp SQLite DBs, minimal `ToolContext` stubs.
6. For grouped tools (multiple operations), use an `action` enum parameter to dispatch (see memory, skill tools).
7. You don't need a per-tool byte cap for correctness — a universal 256 KiB backstop runs at the dispatch return (see `capToolResultContent` in the Common Gotchas list). But adding a per-tool cap with a domain-specific truncation message (like `read`'s line-aware cap or `query`'s row-aware cap) gives the LLM a more actionable error than the generic middle-truncation marker, so prefer it for tools whose outputs commonly approach the cap.

## PR Expectations

- `bun run lint` clean (or `bun run lint:fix` first)
- `bun run typecheck` clean across all packages
- Relevant tests added or updated
- For user-visible changes: update `README.md` and/or `docs/design/*`
- For new invariants or gotchas: add them here

See the git log for commit message style — concise, conventional-commits-ish (`feat(web):`, `fix(llm):`, etc.), present tense.

## Further Reading

- [README.md](README.md) — user-facing overview and quickstart
- [docs/design/architecture.md](docs/design/architecture.md) — package dep graph and data flow
- [docs/design/core-infrastructure.md](docs/design/core-infrastructure.md) — schema, DI, config, outbox internals
- [docs/design/sync-protocol.md](docs/design/sync-protocol.md) — Ed25519, HLC, reducers, relay
- [docs/design/agent-system.md](docs/design/agent-system.md) — agent loop, context pipeline, native tools
- [docs/design/sandbox-and-llm.md](docs/design/sandbox-and-llm.md) — VFS, driver shims, model routing
- [docs/design/web-and-discord.md](docs/design/web-and-discord.md) — HTTP API, WS protocol, platform connectors
- [docs/cli-operations.md](docs/cli-operations.md) — operator-facing CLI reference
