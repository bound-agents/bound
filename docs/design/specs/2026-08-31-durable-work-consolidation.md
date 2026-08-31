# RFC: Durable Work Consolidation — One Per-Host Spool

**Supplements:** `2026-06-29-unified-delegation.md`, `2026-05-26-task-lifecycle-resilience.md`  
**Date:** 2026-08-31  
**Status:** Draft  
**Issue:** #253

---

## 1. Problem Statement

Bound currently represents delivery work in three local tables with three partially overlapping lifecycle implementations: `relay_outbox`, `relay_inbox`, and `dispatch_queue`. `relay_inbox` also carries two incompatible meanings: directed relay messages processed by the relay processor, and passive intake envelopes consumed by the scheduler. `tasks` adds a fourth, synced, claim-shaped implementation, although its distributed claim is explicitly heuristic rather than consensus.

This split has concrete costs. A kind must be taught to every component that happens to know about its consumer. The `connector_intake` stale-recovery omission fixed in #252 is the direct example. Directed work can occupy an outbox, an inbox, then a dispatch queue before its real consumer sees it. The same transition guards, recovery cases, expiry behavior, and duplicate-delivery questions are independently expressed in each implementation.

Stages 1–3 of #253 removed immediate prerequisites:

- #254 (`3e8b8f58`) makes relay consumers duplicate-safe for the known `client_tool`, streaming-inference, and notify-wakeup gaps.
- #252 (`57775978`) restores `connector_intake` stale sweeping.
- `796e732a` introduces `intake-kind-registry.ts`; passive-kind membership is declared once and relay exclusion, payload folding, re-arm, and sweeping derive from it.

This RFC specifies stages 4–5: collapse local delivery storage, then separate synced schedule definitions from locally executable work.

## 2. Scope and Non-Goals

### 2.1 In scope

This RFC defines the durable-work data model, its consumer registration model, directed spool transfer, migration from the existing local tables, and the final split between task bindings and task firings.

### 2.2 Non-goals

- This RFC does **not** replace `change_log` or `sync_state`, alter change-log reducers, or turn replication into a work queue.
- This RFC does **not** add direct spoke-to-spoke transport. Relay remains the existing authenticated transport path.
- This RFC does **not** promise distributed exactly-once execution. Cross-host work remains at-least-once at the transport boundary; idempotent consumers are required.
- This RFC does **not** change the connector, RSS, webhook, or client-session binding tables. Their cursors and `next_run_at` values are watermarks, not queues.
- The #219 permanently-dead-leader residual is deferred. A synced pending-delivery ledger is described in §9, but is not part of this migration.

## 3. End State

There are exactly two durable pending-work stores.

| Store | Purpose | Retirement model | Scope |
|---|---|---|---|
| `change_log` + `sync_state` | Replication log | every relevant peer cursor must pass a record | local log with replicated payloads |
| `durable_work` (name provisional) | Directed and local work spool | one successful consumption, unless a registered cursor policy says otherwise | one local table per host |

`change_log` is broadcast replication, not delivery storage. Its retention remains controlled by peer watermarks. It is deliberately untouched by this RFC.

The work table replaces `relay_outbox`, `relay_inbox`, and `dispatch_queue`. Each host owns its local table. Rows are never synced through the change-log outbox.

### 3.1 Work row shape

The precise SQL is an implementation decision, but every row shall have the following logical fields:

```ts
type DurableWorkRow = {
  id: string;
  target_site_id: string;           // this host or a named peer
  kind: string;
  idempotency_key: string | null; // null permitted only for migration-fenced legacy rows
  created_at: string;
  expires_at: string | null;
  claim_state: "pending" | "processing" | "transferring" | "dead_letter";
  claim_token: string | null;
  claimed_at: string | null;
  attempt_count: number;
  last_error: string | null;
};
```

A kind declaration supplies the row’s payload schema, expiry/TTL, retry and dead-letter policy, target-routing rules, and the handler or cursor registration through which it is consumed. The table may carry additional implementation fields (for example transfer identity and stream correlation); it shall not acquire per-kind lifecycle columns.

### 3.2 Local and peer delivery

A row whose `target_site_id` is the owning host is claimed and acknowledged locally under `BEGIN IMMEDIATE`. This is the existing `dispatch_queue` discipline: one SQLite writer serializes `pending → processing → retired` and restart recovery returns abandoned processing rows to pending.

A row for another site is drained by relay transport. Transfer does not execute the destination handler in the sender’s process. It first makes a durable destination copy in the receiver’s work table, then acknowledges that fact to the sender. The sender retires its copy only after that transfer acknowledgement. The receiver retires its copy only when its registered consumer acknowledges consumption.

This is the existing relay `delivered`/`processed` double acknowledgement, stated in storage-independent terms:

1. **transfer acknowledgement:** retire the sender copy when the receiver copy is durable;
2. **consumption acknowledgement:** retire the receiver copy when its consumer has durably accepted it.

A lost acknowledgement can repeat a transfer. The destination’s `(kind, idempotency_key)` fence, or the transfer identity for legacy rows, makes this safe.

### 3.3 Passive intake becomes ordinary work

`webhook_intake`, `rss_intake`, and `connector_intake` are work kinds addressed to the bound task/thread, not a special mailbox. Their fold-many-into-one-wakeup behavior belongs to the scheduler’s registered consumer, not the table. This preserves insert-before-emit and processed-after-durable-wakeup ordering while removing the relay processor’s passive-kind exclusion as a private ownership list.

## 4. Consumer-Agnostic Work Definitions

A work definition is data owned by one registry. It extends the passive-intake registry introduced in `796e732a` to every kind: dispatch messages, active relay requests and responses, stream chunks and ends, and intake envelopes.

A definition declares:

- the kind and payload validator;
- backing (`local` for the work table; `synced` is reserved for the deferred variant);
- claim discipline;
- retirement rule;
- routing and idempotency-key construction;
- TTL, retry limit, and dead-letter policy;
- handler registration or subscriber-cursor group; and
- recovery hooks and observability labels.

The registry is the sole source for transport draining, local dispatch, recovery sweeps, orphan handling, dead-letter rendering, event wakeup folding, and test-matrix enumeration. No relay processor, scheduler, or reconciler may maintain an independent kind list.

### 4.1 Parameters, not consumer identity

The state machine is parameterized by three independent axes.

| Axis | Values | Meaning |
|---|---|---|
| Claim discipline | `local-exclusive`, `optimistic-lease`, `none` | who may advance an item and how conflicts recover |
| Retirement rule | `single-ack`, `all-subscriber-cursors-past` | how many successful consumptions retire it |
| Backing | `local`, `synced` | whether accepting-host death may lose the row |

`local-exclusive` is the default for the per-host work table and uses `BEGIN IMMEDIATE`. `optimistic-lease` is retained as a reusable definition for work that cannot gain local exclusivity: local CAS, settle-and-re-read, lease expiry, peer-liveness eviction, and idempotent side effects. `none` is cursor-only; it has no claimant and is used with `all-subscriber-cursors-past` for a replication-log-shaped consumer group.

The current end state has one local work backing and the change-log cursor implementation. The full parameterization is intentional: it prevents a future synced ledger from creating a sixth bespoke lifecycle while avoiding a false claim that local and synced correctness are interchangeable.

## 5. Requirements

### 5.1 Store and registration

**R-DW1.** The system shall retain `change_log` and `sync_state` as the replication log and shall not store directed delivery work in them.

**R-DW2.** The system shall store local dispatch, directed relay requests/responses, relay stream records, and passive intake envelopes in one per-host durable work table.

**R-DW3.** Every work kind shall be declared in one consumer-agnostic registry. Dispatch, transport draining, recovery, reconciliation, payload folding, and tests shall derive kind membership from that registry.

**R-DW4.** A definition shall declare claim discipline, retirement rule, backing, idempotency construction, TTL/dead-letter policy, payload validation, and consumer registration.

**R-DW5.** A new work kind shall provide a non-null deterministic idempotency key before it can be registered. A migration adapter may admit legacy rows with null keys only while legacy tables exist; it shall fence such rows by immutable source table plus row ID/transfer identity and shall never emit a newly-created null key.

**R-DW5a.** The consolidated-table definitions for client tools, inference streams, and notifications shall use these binding idempotency constructions: client tools `client-tool:<threadId>:<callId>`; inference streams `inference-stream:<streamId>`; notifications `notify:<notificationId>`, where `notificationId` is a producer-minted UUID minted once at creation and carried across retries. Migration to the work table shall not change these identities: a row migrated or dual-written from a legacy table shall carry the same key it would have had, so the fence holds across the migration boundary.

### 5.2 Claims, retirement, and recovery

**R-DW6.** While a local-targeted row is claimed, the system shall perform selection and transition under `BEGIN IMMEDIATE`; at most one local consumer may own a successful claim generation.

**R-DW7.** The system shall support `local-exclusive`, `optimistic-lease`, and `none` claim disciplines. `optimistic-lease` shall require settle-delay LWW-loss abort, lease expiry, host/heartbeat eviction, and consumer idempotency.

**R-DW8.** The system shall support `single-ack` and `all-subscriber-cursors-past` retirement rules. A single-ack row shall retire only after its registered consumer durably accepts it. A cursor-retained row shall retire only after all registered subscriber cursors have passed it.

**R-DW9.** On process boot, local rows stranded in `processing` without a live claim generation shall be reset to `pending` according to their definition. The existing `dispatch_queue` `processing → pending` reset is generalized; no kind may rely on process memory to complete recovery.

**R-DW10.** A peer-targeted row shall not retire on the sender until the receiver has durably inserted or deduplicated its destination copy and sent a transfer acknowledgement. The receiver shall not retire the destination copy until its consumer acknowledgement.

**R-DW11.** Every kind shall define a finite TTL or an explicit no-expiry rationale, retry policy, and terminal dead-letter representation. Expiry and terminal retry failure shall preserve enough payload, key, timestamps, and error context for operator diagnosis; they shall not silently discard work.

### 5.3 Streams and compatibility

**R-DW12.** Stream chunks shall be ordinary kind-scoped rows with a short TTL. The stream consumer shall deduplicate and order chunks by the existing monotonic sequence semantics; transfer duplication or reordering shall not produce a duplicate visible chunk.

**R-DW13.** Migration shall support a mixed-version cluster. For each moved local table, new hosts shall dual-read the legacy table and the work table until all active hosts advertise a version that understands the work-table protocol. New hosts shall write the work table as authoritative and bridge legacy-origin rows into it idempotently. A flag day is rejected because an offline laptop can otherwise strand pre-upgrade relay rows or become unable to receive traffic from a new peer.

**R-DW14.** Legacy relay and dispatch rows with null idempotency keys shall remain deliverable only through the R-DW5/R-DW14 migration fence during the bridge period, using a derived identity fence. Once their source tables are empty and all supported hosts understand mandatory keys, schema/runtime validation shall reject null keys for every newly inserted work row.

**R-DW15.** A destructive drop of a legacy table shall occur only after its bridge reader has observed it empty, all supported peers advertise the compatible work protocol, and an upgrade rollback no longer requires its rows.

### 5.4 Scheduler split

**R-DW16.** `tasks` shall remain a synced schedule and binding table: trigger definition, binding identity, dependency edges, `next_run_at` watermark, status/results, and peer-liveness/heartbeat observations shall continue to replicate through the change-log outbox.

**R-DW17.** When a task becomes due, only its rendezvous-selected host shall enqueue the deterministic firing artifact as a local work row. The local work claim, not a synced task-row CAS, shall serialize actual execution on that host.

**R-DW18.** The scheduler shall preserve its existing cross-host safeguards: rendezvous host selection; the settle delay and LWW-loser abort described in `scheduler.ts:42–53` and `1328–1337`; lease/heartbeat-based peer eviction; and deterministic firing artifacts whose LWW collision behavior is described near `scheduler.ts:1427–1435`.

**R-DW19.** An event task shall remain a persistent listener. After completion it shall return to pending with `next_run_at = NULL`; it shall re-arm immediately only when registered unconsumed intake work arrived during the run, and shall not gain a periodic fallback wakeup. Retry remains bounded and contingent on retained unconsumed work.

**R-DW20.** Synced schedule writes shall obey invariant #1’s change-log outbox and invariant #20’s no-foreign-key rule. The local work table, transfer acknowledgements, boot recovery, and dead-letter transitions shall be local-only dedicated CRUD operations.

## 6. Task Firing: Decision C

`tasks` currently looks like a synced queue because it carries status, claim, lease, and heartbeat fields. Its claim is not cluster mutual exclusion: two partitioned SQLite replicas can each win local CAS. `scheduler.ts` documents the later re-read as a heuristic, not consensus. The actual duplicate mitigation is rendezvous selection plus deterministic artifacts whose LWW resolution collapses equivalent state.

Decision C makes that boundary explicit. A task row is a replicated definition and liveness record. A firing is local executable work.

1. Each host evaluates due bindings from its synced `tasks` replica.
2. It computes the existing rendezvous winner.
3. Only the winner creates the deterministic firing artifact and enqueues a local `task_fire` work row.
4. `BEGIN IMMEDIATE` claims that local row and the worker runs the task.
5. Completion, retry, cron advance, event reset, results, and peer-eviction observations update the synced binding using the existing guarded semantics.
6. If the winner dies, another host obtains the same definition through sync, recomputes the artifact, and recovers by the existing rendezvous/settle/idempotency mechanisms.

This does not strengthen the current cross-host guarantee; it moves the actual local exclusivity to the place where SQLite can provide it and preserves the current cluster-level behavior explicitly.

## 7. Invariant #3 Replacement

The present invariant is:

> **3. Relay tables are local-only** — `relay_outbox`, `relay_inbox`, `relay_cycles` do NOT use the change-log outbox. Use the dedicated CRUD helpers (`writeOutbox`, `insertInbox`, …) from `@bound/core`.

After migration it shall be replaced by:

> **3. Durable work and relay telemetry are local-only** — `durable_work`, its transfer/claim/dead-letter records, and `relay_cycles` do NOT use the change-log outbox. Use the dedicated durable-work and relay CRUD helpers from `@bound/core`. `change_log` and `sync_state` remain replication state, not directed-work storage.

The before/after deliberately does not classify a table by its historical `relay_*` name. It preserves the local-only constraint while making the transport/spool boundary clear.

## 8. Migration Slices and Rollback

Every slice must leave the preceding production path runnable and must be independently testable.

### Slice 4A — Local work foundation and registry expansion

Add the local table, dedicated CRUD, state-machine transition guards, row validator, observability vocabulary, and a registry that can describe every existing work kind. Keep all production writes on legacy tables. Add parity tests for claims, restart recovery, transfer dedup, expiry, and registry completeness.

**Rollback:** stop selecting the new table; the table is additive and can remain unused. No legacy producer or consumer changed.

### Slice 4B — `dispatch_queue` kinds

Move local thread-message dispatch to `durable_work` with `local-exclusive` plus single-ack. New code dual-reads both sources and bridges any legacy row through a derived legacy identity. This is first because it has one host, no relay transfer, and directly proves claim/recovery behavior.

**Rollback:** route new enqueues back to `dispatch_queue`; dual-read drains work-table dispatch rows until empty. Do not drop either table.

### Slice 4C — Passive intake kinds

Move webhook, RSS, and connector intake rows to the work table using the existing registry as the authoritative declarations. The scheduler’s folding, completion re-arm, stale sweep, deleted-binding handling, and duplicate wakeup behavior operate through registered kinds. New receivers bridge legacy inbox passive rows.

**Rollback:** restore legacy intake insertion while retaining dual reads; work-table rows are drained through the same scheduler consumer. Existing binding/cursor state remains untouched.

### Slice 4D — Active relay RPC and streaming

Move directed requests, results, errors, client tool calls, inference requests, stream chunks, and stream ends to spool transfer. Implement transfer acknowledgement before sender retirement; apply kind-scoped TTLs and stream sequence dedup. During mixed versions, a new host dual-reads both stores and bridges legacy `relay_outbox`/`relay_inbox` rows. New-to-new traffic uses the new protocol; new-to-old traffic retains the legacy envelope until capability negotiation says otherwise.

**Rollback:** capability negotiation selects the old relay envelope for every peer; bridge readers drain new rows, so an already-created new row is not discarded. This is why table-by-table flag days are unsafe.

### Slice 4E — Retire relay storage

After every supported host advertises work-spool support, bridge readers observe no legacy rows, and rollback support has expired, delete relay-table writers/readers and then drop `relay_outbox` and `relay_inbox`. `relay_cycles` remains telemetry. Update invariant #3 to the text in §7.

**Rollback:** before the destructive compatibility horizon, retain a release capable of re-enabling bridge readers. After the drop, rollback means forward-fixing from backup/migration tooling, not pretending an older binary can safely recreate a discarded local spool.

### Slice 5 — Split task firings from bindings

Only after the local spool and its claim/recovery behavior are proven, change `tasks` to schedule/binding semantics and enqueue deterministic local `task_fire` rows on the rendezvous winner. Preserve all scheduler mechanics listed in R-DW18 and event semantics in R-DW19. This is last because it changes scheduler behavior, while stages 4A–4E establish the local execution primitive it needs.

**Rollback:** retain the legacy scheduler firing path behind a release-scoped compatibility switch until dual execution comparison proves that the same deterministic artifact would be selected. Disable new firing creation, drain or deterministically reconcile unclaimed `task_fire` rows, and resume legacy claiming. Never run both execution paths for the same artifact without the shared idempotency fence.

The order is intentional: build and verify the primitive; migrate the single-host client; migrate the already-registered passive consumers; migrate transfer and streams; remove the superseded tables; then move the scheduler, whose semantics depend on every earlier property.

## 9. Deferred Synced Pending-Delivery Ledger

The #219 residual remains: after a synced RSS cursor advances, a permanently dead accepting host can leave its local intake row unreachable. This is a durability-boundary decision, not a cleanup item.

If required later, it fits this design without a new queue species: a work definition with `backing: synced`, `claimDiscipline: optimistic-lease`, `retirementRule: single-ack`, recipient/binding routing metadata, and an idempotent intake consumer. It would use the same registry, expiry/dead-letter vocabulary, recovery sweep, and test matrix. It must separately solve broadcast replication cost and min-peer-watermark retention; it is therefore explicitly excluded from the local-spool migration.

## 10. Acceptance Criteria

- A registry-completeness test fails if any work kind is not consumed, recovered, and observed through its declaration.
- Local claim tests prove one execution across concurrent claimers and `processing → pending` restart recovery.
- Transfer tests prove sender retirement only after durable receiver insert, receiver retirement only after consumption, and duplicate/lost acknowledgements are harmless.
- Mixed-version integration tests cover old→new, new→old, and offline-peer catch-up for dispatch, intake, RPC, and streaming.
- Stream tests prove duplicate/reordered chunk rows do not duplicate visible output and expire according to their kind policy.
- Scheduler tests preserve rendezvous selection, settle-loss abort, stale lease/heartbeat eviction, deterministic artifact identity, cron rescheduling, and event mid-run re-arm without periodic spin.
- No new work insert accepts a null idempotency key; migration tests demonstrate legacy null-key fencing.
- Architecture and invariant documentation describe two stores and the revised invariant #3.

## 11. Open Questions for Operator Review

1. **Retention of dead letters:** should dead-letter payloads remain in the local database until explicit operator purge, or have a long bounded retention TTL (for example 30 days)? The answer affects disk bounds and post-incident evidence.
2. **Compatibility horizon:** what minimum released-version window must the dual-read/legacy-envelope bridge support before destructive relay-table removal? This determines when Slice 4E is permitted.
3. **Task firing identity:** should the deterministic task-fire key be derived solely from `(task_id, scheduled_at)` or include a schedule generation/version to make edited schedules unambiguous during a partition? The existing scheduler behavior must be preserved either way; the key choice needs an explicit compatibility decision.
4. **Transport capability advertisement:** should spool-transfer capability be carried in the existing host metadata/version field or as an explicit synced feature bit? The latter is clearer during rolling upgrades; the former may avoid schema surface.
