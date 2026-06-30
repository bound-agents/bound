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

**Reads** are centralized separately: synced-table `SELECT`s live in the repository layer (`packages/core/src/repositories/`, exported from `@bound/core`), not inlined across feature code. A second CI gate (`scripts/validate-read-centralization.ts`) ratchets the count of inline `db.query(...)` / `db.prepare(...)` reads down against a checked-in baseline. Reads of non-synced tables (`change_log`, `sync_state`, `host_meta`, the relay/dispatch queues, `sqlite_master`, PRAGMAs, FTS5 virtual tables) and arbitrary/dynamic SQL (the `query` tool, `restore`) stay raw and are excluded from that gate.

**The single sanctioned bypass.** A write that intentionally skips the changelog (a per-host hint, local-only instrumentation, a crash-recovery reset, or a one-time startup migration — none of which carry a cross-host correctness invariant) MUST route through `dangerouslyExecuteRawWrite(db, { sql, params, reason })` from `@bound/core`. This is the only call the outbox CI gate permits as a bypass; the deliberately-alarming name and the mandatory `reason` keep every bypass greppable and self-documenting. The former per-line `// outbox-exempt` annotation + audit-table mechanism was replaced by this chokepoint. (`// outbox-routed` still marks raw writes that DO sync via an explicit `createChangeLogEntry` in the same transaction — scheduler CAS transitions, cluster_config CLI commands.)

The narrow set of changelog-exempt writes is documented in the [appendix](#section-a-documented-narrow-exceptions-to-invariant-1-outbox-pattern) at the end of this document.

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

### 15. Platform intake affinity (optimization, not a requirement)

`intake` relay with a `platform` field is routed to the host with that platform connector so the loop runs where the platform tools live. Under the single delegation path (invariant #22) this is an **optimization, not a correctness requirement**: the selected host runs the whole loop LOCALLY (it producer-assembles from its own authoritative state and relays only inference / tool calls outward) — there is no whole-loop `process` delegation. When the chosen host is remote, the same `intake` entry is forwarded to it and it re-selects itself and runs locally. A loop that lands without the platform connector can still reach the tool via the cross-host platform relay (`platform_request`), so affinity saves a round-trip rather than gating correctness. See `docs/design/specs/2026-06-29-unified-delegation.md`.

### 16. Extended-thinking routing

`ChatParams.thinking` is a discriminated union; `ChatParams.effort` rides alongside. The Bedrock driver folds both into `providerOptions.bedrock.reasoningConfig`. Temperature is suppressed whenever `reasoningConfig` is set. Config lives in `model_backends.json` and must be mirrored in `inferenceRequestPayloadSchema` to forward over the relay.

### 17. Shared-config to router hand-off

`toRouterConfig()` in `packages/cli/src/commands/start/inference.ts` is the single place that translates snake_case `ModelBackendsConfig` into the camelCase `BackendConfig` consumed by `createModelRouter`. Any new per-backend field (e.g., `thinking`, `effort`, `max_output_tokens`, `cache_ttl`) MUST be copied here or it silently never reaches the router. `ModelResolution.local` must also carry the field, and both agent-loop and relay-processor must propagate it. For `cache_ttl` specifically, `relay-processor.executeInference` deliberately reads from the local backend (`modelRouter.getCacheTtl(payload.model)`) rather than the payload, so spokes apply their own TTL preference rather than honoring a hub-set TTL for a model the spoke does not support. The same hand-off direction applies to **per-turn cost**: `relay-processor.executeInference` computes `cost_usd` from `appCtx.config.modelBackends.backends` (the hub's authoritative pricing) and stamps it onto the final `done` `StreamChunk`; the spoke's agent-loop happy-path `recordTurn` prefers `parsed.costUsdFromHub` over its own `calculateTurnCost(...)` so hub-only spokes (empty `backends: []`) don't write `cost_usd = 0` for every delegated turn. The local `calculateTurnCost` call remains as the fallback for non-delegated inference and for backward-compat with hubs on pre-fix code.

### 18. Forwarded message_id must reference a real messages row (RETIRED)

**Retired 2026-06-29 — superseded by the single delegation path (invariant #22).** `ProcessPayload` and whole-loop `process` delegation no longer exist, so there is no cross-host `message_id` to forward to a receiving host's `executeProcess()`. The loop always runs locally on the trigger host and relays only inference (as segments) and tool calls; nothing re-resolves a forwarded `message_id` on a remote host. `resolveDelegationMessageId()` survives only as the notification-injection helper (it injects the developer-role wakeup message and returns its id for local dispatch-queue bookkeeping), not as a cross-host forwarding contract. The historical hazard (forwarding a synthetic dispatch-queue id that the remote lookup couldn't resolve) is structurally gone because there is no remote lookup.

### 19. The system role is forbidden in the messages table

`role: "system"` is forbidden in the `messages` table. It is reserved for the LLM driver layer (stable-prefix system prompt). Use `role: "developer"` for any injected system-generated context intended for the agent — notifications, wakeup context, interruption notices, retry nudges. Defense in depth: `insertRow()` throws on `role: "system"` at the write boundary, AND both sync reducers in `packages/sync/src/reducers.ts` reject + log on replay so a peer running pre-fix code cannot corrupt this node via changelog push. Historically, `resolveDelegationMessageId()` (notifications) and the client-tool-expiry injector wrote `role: "system"` rows that Stage 2.5 of context assembly silently dropped; the rows existed in the DB but the LLM never saw them. `readMessageMetadata()` / `writeMessageMetadata()` in `@bound/core` provide an opaque JSON property bag on `messages.metadata` for platform-specific state (e.g. Discord delivery-retry tombstones); keys follow a `<platform>_*` namespace convention and the field is invisible to the agent loop and context assembly.

### 20. No foreign key constraints on synced tables

Synced tables must NOT declare `REFERENCES` / `FOREIGN KEY` constraints. `PRAGMA foreign_keys = ON` is set, but no synced table uses FK clauses. This is intentional: changelog replay, snapshot seeding, and backfill all insert rows in non-deterministic order — a message may arrive before its parent thread, a memory edge before its source node. FK constraints would cause intermittent hard failures during sync that depend on network timing. Referential integrity is enforced by the application write path (outbox helpers), not by the database engine during replay.

### 21. Client tools relay to the session host (affinity is an optimization)

A `notify` / `introspect` wakeup can fire on any host. A thread with a live boundless / `BoundClient` WS session executes `client`-kind tools (`boundless_*`) on the host holding that connection — but under the single delegation path (invariant #22) the loop is NOT forced onto that host. When a loop running elsewhere defers a client tool and finds no local WS connection, it resolves the session host from the synced `client_sessions` table (`resolveClientSessionHost()` in `delegation.ts`) and **relays** a `client_tool` request there; the session host enqueues into its local WS dispatch, awaits the client's result, and relays a `client_result` back (the producer waits on `relay_inbox`, retriable on timeout / session drop). So client-session affinity is now an **optimization** (run where the connection is, save a round-trip), never a must-run-here requirement. The whole-loop delegation that this invariant previously mandated (`getClientSessionDelegationTarget` / `hasLocalClientSession`) is deleted. `enqueueToolResult` is idempotent on `(thread_id, call_id)` so a re-driven `client_result` is a no-op (no double-execution). `client_sessions` must stay in `SYNCED_TABLE_NAMES` / `SNAPSHOT_TABLE_ORDER` so any host can resolve session locations. The introspection helpers survive: `isClientSessionLive()` (any live session anywhere) and `getClientSessions()` (per-(thread,host) rows tagged live/stale) power the `hostinfo` **Client Sessions** section and the shared `clientSessionWakeupWarning()` non-fatal notice. See `docs/design/specs/2026-06-29-unified-delegation.md`.

### 22. One delegation path — consumer never re-assembles

There is exactly ONE delegation mechanism: the **producer** (the host that received the trigger and owns authoritative state) assembles context locally and ships it; no consumer ever re-assembles context from its own (possibly un-synced) replica. The old `process` relay kind, `runDelegatedLoop`/`executeProcess`, the ≥50% tool-affinity `getDelegationTarget`, and the delegate-vs-local branch in `handleThread` are all removed; the loop always runs locally and relays only **inference** and **tool calls**. Inference context travels as `segments: ContextSegment[]` (`packages/agent/src/delegation-segments.ts`): the producer emits at most one `range` segment over the confirmed-synced history prefix plus `inline` segments for the tail (`segmentAssembledMessages`), and the consumer rebuilds history byte-for-byte by re-running the same Stage-1 projection finder + annotator (`resolveSegments`). The consumer has no access to `assembleContext`, so consumer re-assembly is structurally unrepresentable — this is what makes the original `history:0` bug class (a host re-assembling from a replica that wasn't there yet) impossible by construction. The old `messages` / `messages_file_ref` (>2MB files-table offload) payload is gone; `scripts/validate-no-files-relay-offload.ts` (in `bun check`) gates the offload shut.

### 23. Relay history is one range-pointer over confirmed-synced rows

A delegation range segment may cover a message row only if that row's latest `change_log` HLC is ≤ the consumer's **confirmed-sync watermark**, and `getConfirmedSyncWatermark(db, peer)` (the `sync_state.last_confirmed` cursor, exported from `@bound/sync`) is the SOLE authority for that decision — never `last_sent` (optimistic) or `last_received` (inbound). `last_confirmed` advances ONLY on a changelog/snapshot ack from the peer, never on the optimistic send-side write. Because history is an append-only prefix there is at most one range per delegated turn; everything newer than the watermark (including edits to old rows) ships inline. Cold start (peer never acked) ⇒ watermark `HLC_ZERO` ⇒ all segments inline, the safe degenerate case. This guarantees every row a range points at is already present on the consumer — a pointed-at missing row is a hard error that cannot happen by construction.

### 24. Assembly is pure over (DB, AssemblyContext)

`assembleContext()` output is a pure function of its declared inputs `(DB state, AssemblyContext)`; "now" enters only via `AssemblyContext.clock` (`AssemblyClock`; `realTimeClock()` / `frozenClock(ms)`). This extends the R-VC25 stable-prefix purity invariant from the stable subsection to the WHOLE assembly, including the varying Live State half and the `formatInstant` year branch — no wall-clock or environment read may influence byte output. The producer captures one `nowMs` and ships it on the inference relay payload, so the consumer's range re-annotation in `resolveSegments` reproduces the producer's bytes exactly. Two hosts handed the same `(DB, AssemblyContext)` agree byte-for-byte — the cross-host guarantee the single-delegation path depends on. Guarded by the determinism property test (`packages/agent/src/__tests__/assembly-determinism.property.test.ts`).

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

New changelog-exempt writes MUST route through `dangerouslyExecuteRawWrite` (see invariant #1)
and SHOULD be added to the table below. The chokepoint's mandatory `reason` argument carries the
per-call justification; this table is the human-readable index of where the bypasses live.

### Changelog-exempt writes (routed through `dangerouslyExecuteRawWrite`)

Every intentional outbox bypass now funnels through the single `dangerouslyExecuteRawWrite`
chokepoint, which the CI gate at `scripts/validate-outbox-invariant.ts` recognizes as the sole
sanctioned escape (the former per-line `// outbox-exempt` annotation + audit-table cross-check was
retired). Each call below skips the changelog because the write is a per-host signal with no
cross-host correctness invariant.

| Call site | Write target | Why changelog-exempt |
|-----------|-------------|----------------------|
| `packages/agent/src/summary-extraction.ts` (`bumpRenderedDetailEntries`) | semantic_memory.last_accessed_at | Per-host relevance hint; routing through `updateRow` would advance `modified_at` and cascade into stale-child detection (see Section A). |
| `packages/cli/src/commands/start/bootstrap.ts` (`STALE_TASK_RESET_SQL` execution) | tasks (status, lease_id, claimed_by, claimed_at) | Per-host crash recovery scoped to `claimed_by = ?siteId` (see Section A). |
| `packages/core/src/relay-metrics.ts` (`recordTurnRelayMetrics`, no-siteId branch) | turns.relay_target, turns.relay_latency_ms | Local-only instrumentation columns on a synced table; per-host relay metrics are not synced. |
| `packages/sandbox/src/overlay-scanner.ts` (INSERT, UPDATE, soft-delete) | overlay_index | Local index rebuilt from the filesystem on every scan when no outbox is injected (backward-compat path; the outbox-injected path uses `insertRow`/`updateRow`/`softDelete`). |
| `packages/agent/src/task-resolution.ts` (heartbeat migration) | tasks.no_history | One-time, idempotent, self-converging startup migration of a per-host semantic flag. |

Scheduler CAS task transitions, host registration, and cluster_config CLI commands are NOT in this
table: they DO sync, via raw SQL paired with an explicit `createChangeLogEntry` in the same
transaction, marked `// outbox-routed`.
