# Critical Invariants

These rules exist because violating them has historically caused real production incidents (sync loss, SQL injection risk, cache misses, hot loops). [CONTRIBUTING.md](../CONTRIBUTING.md#critical-invariants) carries the one-line index; this file carries the full explanation and mitigation for each. Read the relevant section before writing code that touches the subject.

The numbering is flat and global — there is no category grouping, because the numbers and the old category headings disagreed about order. Read by number.

### 1. Change-log outbox pattern

All writes to synced tables MUST use `insertRow()`, `updateRow()`, or `softDelete()` from `@bound/core` (`packages/core/src/change-log.ts`). Never write directly to a synced table with raw SQL. Synced tables are:

```
users, threads, messages, semantic_memory, tasks, files, hosts,
overlay_index, cluster_config, advisories, skills, memory_edges,
connector_handles, webhooks, turns, client_sessions
```

The source-of-truth type is `SyncedTableName` in `packages/shared/src/types.ts`. Writes bypassing the outbox never generate a `change_log` entry, so other hosts never learn about them.

Two narrow, documented exceptions to this rule, plus the exhaustive audit disposition table the CI gate cross-checks against, are in the [appendix](#section-a-documented-narrow-exceptions-to-invariant-1-outbox-pattern) at the end of this document.

### 2. Soft deletes only

Synced tables use a `deleted = 0|1` column. Never physically `DELETE` rows — use `softDelete()`.

### 3. Relay tables are local-only

`relay_outbox`, `relay_inbox`, `relay_cycles` do NOT use the change-log outbox. Use the dedicated CRUD helpers (`writeOutbox`, `insertInbox`, …) from `@bound/core`.

### 4. Column-name validation

Any SQL that interpolates a column name MUST pass it through `validateColumnName()` (regex `/^[a-z_]+$/`). Values always use parameterized queries. This applies to change-log replay, restore, reducers — anywhere JSON row data could drive column selection.

### 5. OCC filesystem

Compare hash-to-hash (never hash vs raw content). Persist inside `BEGIN IMMEDIATE`. Emit `file:changed` events AFTER the commit, never during.

### 6. Events after commit

`file:changed`, `changelog:written`, and similar events must fire AFTER `db.exec("COMMIT")`. Emitting during the transaction can cause listeners to observe uncommitted state.

### 7. Tool-message persistence

Tool messages must be persisted immediately after each tool execution, before the next LLM call. Batching these persists has caused context drift and duplicate tool calls.

### 8. Empty reads return null, not undefined

`bun:sqlite` `.get()` returns `null` (not `undefined`) when no row is found. Guard accordingly.

### 9. LLM message roles diverge between layers

Two distinct types:
- `MessageRole` in `@bound/shared` (DB + event bus): `user | assistant | system | developer | alert | tool_call | tool_result | purge`
- `LLMMessage.role` in `@bound/llm` (driver input): `user | assistant | system | tool_call | tool_result | developer | cache`

`developer` carries volatile context and MUST be merged into an adjacent user message by the driver/bridge — wrapped in `<system-context>...</system-context>`. Orphan developer-only inputs are dropped. `cache` is a zero-content marker that tells drivers to place a cache breakpoint on the preceding message.

### 10. Message content is string or ContentBlock array

`LLMMessage.content` can be `string | ContentBlock[]`. Code handling messages must account for both forms. String-only assumptions break image/tool-use content.

### 11. Model-alias passthrough

Never pass `payload.model` to `backend.chat()` from the relay processor — `payload.model` is a logical alias (e.g., `"opus"`) that differs from the provider-specific identifier (e.g., a Bedrock ARN). The backend already knows its configured model.

### 12. Canonical edge relations

`memory_edges.relation` must be one of 10 values in `CANONICAL_RELATIONS` (from `@bound/core/memory-relations.ts`): `related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes`. SQLite triggers enforce this. Use the `context` TEXT column for bespoke phrasing. `upsertEdge()` validates before write and throws `InvalidRelationError`.

### 13. Config schemas are closed (strict mode)

Every schema in `configSchemaMap` in `packages/shared/src/config-schemas.ts` uses `.strict()`, so unknown keys fail parse loudly. `cronSchedulesSchema` is closed-by-shape via `.catchall(cronEntrySchema)`. **When adding a config field, declare it in the Zod schema first** — otherwise the loader rejects the file at startup.

### 14. Hub response-kind routing

Response kinds (`stream_chunk`, `stream_end`, `result`, `error`, `status_forward`) targeting the hub itself must be inserted into `relay_inbox`, NOT sent through `executeImmediate()`. The executor only handles request kinds.

### 15. Platform intake affinity

`intake` relay with a `platform` field must route to the host with that platform connector, not the host with the best model. Without this, the agent lacks platform tools (e.g., `discord_send_message`).

### 16. Extended-thinking routing

`ChatParams.thinking` is a discriminated union; `ChatParams.effort` rides alongside. The Bedrock driver folds both into `providerOptions.bedrock.reasoningConfig`. Temperature is suppressed whenever `reasoningConfig` is set. Config lives in `model_backends.json` and must be mirrored in `inferenceRequestPayloadSchema` to forward over the relay.

### 17. Shared-config to router hand-off

`toRouterConfig()` in `packages/cli/src/commands/start/inference.ts` is the single place that translates snake_case `ModelBackendsConfig` into the camelCase `BackendConfig` consumed by `createModelRouter`. Any new per-backend field (e.g., `thinking`, `effort`, `max_output_tokens`, `cache_ttl`) MUST be copied here or it silently never reaches the router. `ModelResolution.local` must also carry the field, and both agent-loop and relay-processor must propagate it. For `cache_ttl` specifically, `relay-processor.executeInference` deliberately reads from the local backend (`modelRouter.getCacheTtl(payload.model)`) rather than the payload, so spokes apply their own TTL preference rather than honoring a hub-set TTL for a model the spoke does not support. The same hand-off direction applies to **per-turn cost**: `relay-processor.executeInference` computes `cost_usd` from `appCtx.config.modelBackends.backends` (the hub's authoritative pricing) and stamps it onto the final `done` `StreamChunk`; the spoke's agent-loop happy-path `recordTurn` prefers `parsed.costUsdFromHub` over its own `calculateTurnCost(...)` so hub-only spokes (empty `backends: []`) don't write `cost_usd = 0` for every delegated turn. The local `calculateTurnCost` call remains as the fallback for non-delegated inference and for backward-compat with hubs on pre-fix code.

### 18. Forwarded message_id must reference a real messages row

`ProcessPayload.message_id` must reference a real `messages` row. When `handleThread()` (spoke side) delegates to a remote host, the `message_id` it forwards via `ProcessPayload` must exist in the `messages` table on the delegating host so the receiving host's `executeProcess()` can resolve it. User-message entries are safe because `enqueueMessage(db, messageId, threadId)` stores the real `messages.id` as `dispatch_queue.message_id`. **Notifications are the trap**: `enqueueNotification()` generates a synthetic UUID — the injected system message gets a fresh UUID in a separate `insertRow()` call. Historically the spoke forwarded the dispatch-queue id, the hub's lookup returned null, and the notification was silently dropped. Use `resolveDelegationMessageId()` in `packages/cli/src/commands/start/server.ts` — it injects notifications AND returns the id to forward. The receiving side no longer hard-rejects on missing rows (it warns and proceeds on thread state alone), but the spoke is still the source of truth and should always forward a real id.

### 19. The system role is forbidden in the messages table

`role: "system"` is forbidden in the `messages` table. It is reserved for the LLM driver layer (stable-prefix system prompt). Use `role: "developer"` for any injected system-generated context intended for the agent — notifications, wakeup context, interruption notices, retry nudges. Defense in depth: `insertRow()` throws on `role: "system"` at the write boundary, AND both sync reducers in `packages/sync/src/reducers.ts` reject + log on replay so a peer running pre-fix code cannot corrupt this node via changelog push. Historically, `resolveDelegationMessageId()` (notifications) and the client-tool-expiry injector wrote `role: "system"` rows that Stage 2.5 of context assembly silently dropped; the rows existed in the DB but the LLM never saw them. `readMessageMetadata()` / `writeMessageMetadata()` in `@bound/core` provide an opaque JSON property bag on `messages.metadata` for platform-specific state (e.g. Discord delivery-retry tombstones); keys follow a `<platform>_*` namespace convention and the field is invisible to the agent loop and context assembly.

### 20. No foreign key constraints on synced tables

Synced tables must NOT declare `REFERENCES` / `FOREIGN KEY` constraints. `PRAGMA foreign_keys = ON` is set, but no synced table uses FK clauses. This is intentional: changelog replay, snapshot seeding, and backfill all insert rows in non-deterministic order — a message may arrive before its parent thread, a memory edge before its source node. FK constraints would cause intermittent hard failures during sync that depend on network timing. Referential integrity is enforced by the application write path (outbox helpers), not by the database engine during replay.

### 21. Client-session affinity wins over model-based delegation

A `notify` / `introspect` wakeup can fire on any host (webhook ingestion and PR-watch tasks run hub-side; the dispatch fires `handleThread` wherever the notify was enqueued). But a thread with a live boundless / `BoundClient` WS session can only execute `client`-kind tools (`boundless_*`) on the host holding that connection — client tool calls defer over that host's local event bus and are unreachable cross-host. So the delegation decision in `packages/cli/src/commands/start/server.ts` consults the `client_sessions` table (synced, LWW) BEFORE model-based `getDelegationTarget()`: (1) a live session on another host → delegate there; (2) a live session on this host → run locally and suppress model delegation (otherwise an opus-backed boundless loop gets pulled to the hub and stripped of its client tools — issue #91); (3) no live session → fall back to model-based delegation. `getClientSessionDelegationTarget()` answers cases 1+3 (returns the remote `EligibleHost` or null), `hasLocalClientSession()` disambiguates case 2. Sessions are recorded on `thread:subscribe`, soft-deleted on `thread:unsubscribe` and on WS close, and a staleness window (`CLIENT_SESSION_HOST_STALE_MS`) guards against a host that died without a clean close. `client_sessions` must stay in `SYNCED_TABLE_NAMES` / `SNAPSHOT_TABLE_ORDER` so peers learn session locations. The same staleness join is exposed for introspection (issue #96): `isClientSessionLive()` (host-agnostic "any live session anywhere") and `getClientSessions()` (per-(thread,host) rows tagged live/stale) live alongside the routing helpers in `delegation.ts`. The `hostinfo` tool renders a **Client Sessions** section from `getClientSessions()`, and `notify` / `introspect` append a shared non-fatal warning (`clientSessionWakeupWarning()`) when the target is a `CLIENT_TOOL_INTERFACES` thread (`boundless`) with no live session — the wakeup still enqueues and delivers on reconnect, but the woken loop can't run client tools meanwhile.

---

## Appendix: outbox exceptions (invariant #1)

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
| packages/agent/src/summary-extraction.ts:1915 | semantic_memory.last_accessed_at | (a) justified | Per-host relevance hint; see Section A above. |
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
| packages/agent/scripts/agent-harness/driver.ts:225 | (none — comment-only) | (e) comment-only | Reference / educational note. |
| packages/agent/src/validation/run-stable-prefix-drift-validation.ts:244 | (none — comment-only) | (e) comment-only | Reference to `bumpRenderedDetailEntries` exception. |
