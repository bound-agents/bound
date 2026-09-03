# #253 Release N+1 Work Order — Delete Legacy Relay, Refuse Startup on Populated Legacy Tables

**Survey HEAD:** `30bf4693` on `main` (verified `git rev-parse HEAD`). Uncommitted-in-flight: `packages/agent/src/client-tool-dispatch.ts` (the #260 fix; see Assumption below).
**Read-only survey. No edits made.** This is the implementer's order.

## Contract (from the #253 migration plan, release N+1)

Delete legacy relay writers/readers/bridge code; refuse startup if local legacy tables (`relay_outbox`/`relay_inbox`) still hold rows — guarding a host that skipped N-1 → N+1. Release N (slice 4E, `5aaecbd3`) already shipped: gated per-host drain-then-drop of `relay_outbox`/`relay_inbox`, capability-gated spool routing, `hasDroppedLegacyRelayTables`. Both live cluster hosts have passed the 4E gate (tables dropped).

## Assumption about in-flight #260 (thread `4b38e515`)

This order assumes #260 has merged before the N+1 implementer runs. #260 migrates `client-tool-dispatch.ts:waitForRemoteResult` and `bound-agent-loop.ts:createClientResultWait$` onto `readUnionResponseEntry` from `relay-await-helpers.ts`, and deletes `agent-loop-utils.ts:waitForRelayInbox` as stale. The union helpers keep a **legacy-first read branch** (`hasDroppedLegacyRelayTables(db) ? null : readInboxByRefId(db, refId)` at `relay-await-helpers.ts:54`). **N+1 deletes that branch too.** If #260 has NOT merged when the implementer picks this up, Phase 3 must additionally absorb the two hand-rolled awaiters — treat that as a scope add and flag it, don't silently do both.

---

## Key decisions (summary — full detail below)

1. **Loopback replacement (sharpest design question).** Today `shouldRouteRelayDurable` (`relay-router.ts:485`) returns `false` for a self-targeted request, and the whole loopback dance runs through `relay_outbox` → the relay-processor's single-host loopback pass (`relay-processor.ts:395-436`) re-inserts request kinds into `relay_inbox`. **After N+1 there is no `relay_outbox`/`relay_inbox` to loop through.** The replacement already exists and is proven: the `LOCAL_WORK_TARGET = "local"` sentinel path (`durable-work.ts:45`), used today by dispatch wakeups. **Recommendation:** self-targeted active relay requests route to a `durable_work` row with `target_site_id = LOCAL_WORK_TARGET`, consumed in-process by the owning host's durable-work relay lane — NOT peer-transferred (every transfer selector already excludes the sentinel; boot recovery `resetTransferringLocalDurableWork` already resets a stranded `transferring` local row). This unifies loopback with the dispatch-wakeup mechanism and removes the last dependency on the single-host loopback pass. See §1-LOOPBACK for the exact code change and the one subtlety (response correlation for a self-targeted RPC).

2. **Version-skew frame handling (compatibility decision).** An N host (pre-drop, still speaking legacy envelopes) can send a `RELAY_SEND` frame (`ws-frames.ts:0x03`) to an N+1 host. But **N+1 hosts DO advertise `work_spool_capable`**, so a correctly-behaving N peer with a fresh `hosts` snapshot sends spool-only. A legacy `RELAY_SEND` reaching an N+1 host can only come from a peer with a STALE snapshot. Today (release N) the dropped-host receive path REFUSES gracefully (no ack, sender retries over spool once it re-reads the advertisement — `ws-transport.ts:1007-1020`). **Recommendation:** N+1 keeps that refusal but makes it **loud and permanent** — the `RELAY_SEND` frame handler in `ws-server.ts:430` / `ws-client.ts:630` and `handleRelaySend` in `ws-transport.ts` are NOT deleted (the frame type stays in the protocol enum for wire-compat), but `handleRelaySend` becomes an unconditional structured-warn-and-drop (no `insertInbox`, no ack). Do NOT delete the frame decode — an unknown frame type would close the connection (1011) and a stale N peer would connection-flap. Refuse the payload, keep the socket. See §7-SKEW.

3. **Startup refusal.** Lives in `schema.ts` (the schema-init path called from `createAppContext`, `app-context.ts:39`), immediately after `local_flags` is created and BEFORE the `if (!legacyRelayRetired)` block is deleted. Exact check: for each of `relay_outbox`, `relay_inbox` (raw `sqlite_master` existence probe, NO schema/type dependency — the table types are being deleted), if the table EXISTS and `COUNT(*) > 0`, throw an operator-actionable error naming the release-N binary. See §4.

4. **dispatch_queue is OUT of scope.** It moved in 4B/4C behind its own `BOUND_DURABLE_DISPATCH` toggle (`dispatch.ts:8`) and was NOT given the 4E drain-drop treatment — it has no `hasDropped*` gate and its CREATE TABLE (`schema.ts:1158`) is unconditional. `dispatch_queue` is still an active legacy fallback for dispatch wakeups. **N+1 does NOT touch it.** Only `relay_outbox`/`relay_inbox` are in scope.

5. **Toggle deaths.** `BOUND_DURABLE_RELAY` / `DURABLE_RELAY_ENABLED` die (the legacy-rollback value has no legacy path to roll back to). `BOUND_DURABLE_INTAKE` / `DURABLE_INTAKE_ENABLED` die for the same reason (its rollback target is legacy `relay_inbox` writes). `BOUND_DURABLE_DISPATCH` SURVIVES (dispatch_queue out of scope). `BOUND_TASK_FIRE_MODE` SURVIVES (unrelated).

---

## Ordered work order — phases, each independently green

Each phase is a committable unit that leaves `bun run typecheck` + `bun test --recursive` green. Ordered so no phase leaves a dangling reference.

### Phase 0 — Startup refusal (additive, ships alone, guards everything after)
Add the check FIRST so that if a populated-legacy-table host somehow reaches N+1, it refuses before any deleted code path is exercised. Additive; no deletions. Independently green. See §4.

### Phase 1 — Delete legacy WRITERS (producer side)
- `relay-router.ts`: delete the `legacy` branch of `routeRelayRequest`/`routeRelayResponse`; delete `createRelayOutboxEntry`; rewrite `shouldRouteRelayDurable` (drop the `!DURABLE_RELAY_ENABLED` gate and the self-target→false; wire the loopback replacement, §1-LOOPBACK).
- `ws-transport.ts`: delete `insertInbox` call sites (hub-local + broadcast fan-out inbox inserts) and the hub self-routing `markDelivered`/`writeOutbox` durability branch; `handleRelaySend` becomes warn-and-drop (§7-SKEW).
- `mcp-registry.ts:761`, `rss-poller.ts`, `webhook-handler.ts`: delete the `writeOutbox`/`insertInbox` legacy-intake branches (the `forceDurable`/`DURABLE_INTAKE_ENABLED` conditionals collapse to always-durable).
- `relay-processor.ts:411`: delete the single-host loopback `insertInbox` pass (replaced by LOCAL_WORK_TARGET routing, §1-LOOPBACK).
- `core/src/relay.ts`: delete `writeOutbox`, `insertInbox`.
See §1 for the full file:line inventory.

### Phase 2 — Delete legacy READERS (consumer side)
- `core/src/relay.ts`: delete `readInboxByRefId`, `readInboxByStreamId`, `readUnprocessedInboxByRefId`, `findStaleUnprocessedIntake`, `markProcessed`, `pruneRelayTables` (outbox/inbox halves), `readUndelivered`, `readUnprocessed`, `markDelivered`/`markDeliveredForTarget`, `StaleIntakeGroup`.
- Union-read sites drop their legacy branch (each becomes durable-only): `relay-await-helpers.ts:54`, `relay-wait$.ts` (readUnionResponse), `relay-stream$.ts:141`, `bound-agent-loop.ts:1745`, `event-payload.ts:169` (buildEventWakeupContent's `readUnprocessedInboxByRefId`).
- `relay-processor.ts`: delete every `markProcessed` call (~18 sites) and the `!hasDroppedLegacyRelayTables` guarded legacy passes; the processor becomes durable-only (`processPendingDurableWork` is the whole body).
- `scheduler.ts`: delete legacy `markProcessed`/`hasDroppedLegacyRelayTables` branches (`564`, `1205`, `2149`); the fold reads durable intake only.
- `webhook-intake-reconciler.ts:131`: drop legacy `markProcessed`.
See §2 for the full inventory and which functions delete entirely vs. drop-a-branch.

### Phase 3 — Delete BRIDGE / transition code
- `relay-retirement.ts`: **delete the entire file** (drain-then-drop is the N-1→N recovery path; N+1 refuses startup instead — the drain machinery has no reason to exist). Delete its call site (the startup + periodic `runRelayRetirementPass` wiring — grep `runRelayRetirementPass`).
- `core/src/relay.ts`: delete `hasDroppedLegacyRelayTables`, `dropLegacyRelayTables`, `legacyRelayTablesEmpty`, `countLegacyRelayRows`, `markDroppedInCache`, `droppedMarkerCache`, `LEGACY_RELAY_DROPPED_FLAG`. Every `hasDroppedLegacyRelayTables(db)` call site becomes constant-`true` → delete the gate and the now-dead legacy branch (inventory in §3). Note: the `local_flags` marker row (`relay_legacy_tables_dropped`) can be left in place on already-dropped hosts — harmless; do NOT add migration code to purge it (that's transition process, out of end-state scope).
- `durable-work.ts`: delete `DURABLE_RELAY_ENABLED`, `DURABLE_INTAKE_ENABLED`, and their setters + `BOUND_DURABLE_RELAY`/`BOUND_DURABLE_INTAKE` reads. **Keep** `DURABLE_DISPATCH` and `LOCAL_WORK_TARGET`.
- `schema.ts:714`: delete `const legacyRelayRetired = hasDroppedLegacyRelayTables(db)` and the `if (!legacyRelayRetired)` block wrapping the `relay_outbox`/`relay_inbox` CREATE TABLE + indexes (§5) — the tables are never created on N+1.

### Phase 4 — Delete SCHEMA / TYPES
- `schema.ts:718-772`: the `relay_outbox`/`relay_inbox` CREATE TABLE + index block (already removed in Phase 3 with the gate); also remove the historical ALTER migrations (`843/848/861/877/882/1088-1112`) — dead once the tables are never created. Keep `relay_cycles` (telemetry, retained).
- `shared/src/types.ts:673,688`: delete `RelayOutboxEntry`, `RelayInboxEntry` types (verify no surviving importer — Phase 1/2 removed the CRUD that used them). Keep `RelayKind`, `RELAY_KIND_REGISTRY`, `RELAY_REQUEST_KINDS`, `RELAY_RESPONSE_KINDS` (the spool uses kinds).
- `sync/src/changeset.ts:17,20`: `RelayResponse.relay_inbox` / `RelayRequest.relay_outbox` — these are the legacy HTTP-sync relay changeset shapes; verify they are dead (the WS transport replaced HTTP relay) and delete, or leave the wire types if any HTTP `/sync/relay` path survives (grep `/sync/relay` — confirm dead first).
- `core/src/index.ts`: prune the deleted exports (`markProcessed`, `readInboxByRefId`, `readInboxByStreamId`, `hasDroppedLegacyRelayTables`, `DURABLE_RELAY_ENABLED`, `DURABLE_INTAKE_ENABLED`, etc.).

### Phase 5 — Tests + docs
Delete/rewrite the test files pinning legacy behavior (§6-TESTS) and update the docs (§6-DOCS). Ships with the code phases per CONTRIBUTING (docs in the same PR); split into its own commit for review clarity but land together.

---

## §1 — LEGACY WRITERS (full inventory)

Production INSERT sites into `relay_outbox`/`relay_inbox` and their replacements:

| File:line | What it does | N+1 replacement |
|---|---|---|
| `core/src/relay.ts:86-170` `writeOutbox` | INSERT OR IGNORE relay_outbox | **Delete.** |
| `core/src/relay.ts:243-265` `insertInbox` | INSERT OR IGNORE relay_inbox | **Delete.** |
| `agent/src/relay-router.ts:587-599` `routeRelayRequest` legacy branch | `createRelayOutboxEntry` + `writeOutbox` | **Delete branch;** always durable (spool or LOCAL_WORK_TARGET). |
| `agent/src/relay-router.ts:679-693` `routeRelayResponse` legacy branch | same | **Delete branch;** always durable. |
| `agent/src/relay-router.ts:425-450` `createRelayOutboxEntry` | builds outbox row | **Delete** (only the legacy branches call it). |
| `sync/src/ws-transport.ts:980-1001` broadcast fan-out `insertInbox` (hub own inbox) | hub self-inbox on `*` target | **Delete** — broadcast rides spool. |
| `sync/src/ws-transport.ts:1007-1051` hub-local `insertInbox` | hub-targeted request → inbox | **Delete;** hub-targeted request arrives as spool transfer. |
| `sync/src/ws-transport.ts:1205` sendRelayDeliver inbox insert | spoke-side deliver → inbox | **Delete** if dead post-spool (verify against `handleRelayDeliver`). |
| `sync/src/ws-transport.ts` hub self-routing branch (`~854-908`) | routes hub-own outbox entries, `markDelivered` | **Delete** — hub-own active relay rides spool. |
| `agent/src/relay-processor.ts:411` single-host loopback `insertInbox` | re-inserts self-outbox request kinds into inbox | **Delete;** loopback rides LOCAL_WORK_TARGET (§1-LOOPBACK). |
| `platforms/src/mcp-registry.ts:761` `writeOutbox` | legacy intake write | **Delete branch;** `forceDurable`/`DURABLE_INTAKE_ENABLED` collapse to always-durable. |
| `platforms/src/rss-poller.ts:588-599` legacy intake | `this.deps.insertInbox` fallback | **Delete branch.** |
| `web/src/server/webhook-handler.ts:235-248` legacy intake | `DURABLE_INTAKE_ENABLED`-gated inbox write | **Delete branch.** |

**R-DW14 capability gate after N+1:** A non-advertising peer is simply **unreachable for relay** — `shouldRouteRelayDurable` no longer has a legacy fallback to return, so a target (or hub hop) that doesn't advertise `work_spool_capable` must produce a routing **error** ("target does not speak the work-spool protocol"), not a silent legacy write. The spec (R-DW14, spec §line 155) says "Transport shall send spool transfers only to peers that advertise the bit" — it does not mandate a legacy fallback, and N+1 removes the only one. Since both live hosts advertise, this error is a stale-topology / version-skew guard, not a normal path. Recommendation: `routeRelayRequest`/`routeRelayResponse` return a typed error result on non-advertising destination; callers surface it as a relay failure (retriable). Do NOT keep `RouteRelayRequestResult.path` as `"durable" | "legacy"` — it becomes `"durable" | "local"` (loopback) with error as a separate variant.

### §1-LOOPBACK — self-targeted request replacement (design proposal)

**Today:** `shouldRouteRelayDurable` returns `false` on `targetSiteId === localSiteId` (`relay-router.ts:485`); the request writes `relay_outbox`; the relay-processor's single-host loopback pass (`relay-processor.ts:395-436`) reads self-targeted undelivered outbox rows, re-inserts REQUEST kinds into `relay_inbox` (so the local awaiter's union read finds them), and marks the outbox row delivered. Response kinds are discarded. This is the ONLY consumer of `relay_outbox` self-rows and it dies with the tables.

**N+1 replacement:** route a self-targeted active relay REQUEST to a `durable_work` row with `target_site_id = LOCAL_WORK_TARGET` (`"local"`), consumed in-process. This is the exact mechanism dispatch wakeups already use (`dispatch.ts:46`), and the durable-work relay lane already claims `LOCAL_WORK_TARGET` rows via `claimLocalDurableWork` (the readers at `durable-work.ts:817-861` already union `target_site_id IN (ownSiteId, LOCAL_WORK_TARGET)`). Concretely:

- In `routeRelayRequest`, when `targetSiteId === sourceSiteId`, insert a durable row with `target_site_id = LOCAL_WORK_TARGET`, same kind/payload/idempotency/ref_id/source_site as the peer path. It is claimed and dispatched by the local relay lane (`processPendingDurableWork`, `relay-processor.ts:462+`), which already handles every request kind.
- **The one subtlety — response correlation.** A self-targeted RPC needs its response to come back to the same in-process awaiter. The response is written by the handler via `routeRelayResponse(targetSiteId = original source = self)`. That is ALSO self-targeted → also LOCAL_WORK_TARGET. The awaiter (`readUnionResponseEntry` post-#260, now durable-only after Phase 2) calls `readDurableResponseByRefId(db, refId, ownSiteId)` which reads `target_site_id IN (ownSiteId, LOCAL_WORK_TARGET)` (`durable-work.ts:817`) — so it already finds a LOCAL_WORK_TARGET response row addressed by `ref_id`. **No new reader needed.** Verify `readDurableResponseByRefId`'s WHERE covers LOCAL_WORK_TARGET (it does per the sentinel-union at `817`), and that the relay lane does NOT claim response kinds for a LOCAL_WORK_TARGET row (the existing guard `relayKind.dispatch === "response" → continue` at `relay-processor.ts:472` already excludes them; the awaiter is the sole response consumer — same contract as the peer path).
- `shouldRouteRelayDurable`: delete the `targetSiteId === localSiteId → false` line. Add a helper `routeSelfTargeted(): "local"` or fold it into `routeRelayRequest` directly (the router is the right home). The peer-capability gate (target advertises + hub hop advertises) is unchanged for peer targets.

**Blast:** `relay-router.ts` (routing decision + insert target), `relay-processor.ts` (delete the loopback pass — its work is now the ordinary LOCAL_WORK_TARGET claim). Tests: `relay-durable-routing.test.ts`, `relay-processor-core.test.ts` (loopback cases → rewrite as LOCAL_WORK_TARGET cases).

---

## §2 — LEGACY READERS (full inventory)

**Functions in `core/src/relay.ts` that delete entirely:** `readInboxByRefId` (293), `readInboxByStreamId` (378), `readUnprocessedInboxByRefId` (315), `findStaleUnprocessedIntake` (~355), `markProcessed` (268), `pruneRelayTables` (273 — outbox/inbox halves; if `relay_cycles` prune shares this fn, split it), `readUndelivered`, `readUnprocessed`, `markDelivered`, `markDeliveredForTarget`, `StaleIntakeGroup` interface.

**Union-read sites — drop the legacy branch, keep durable:**
| File:line | Legacy branch | Becomes |
|---|---|---|
| `relay-await-helpers.ts:54` | `hasDropped ? null : readInboxByRefId` | `readDurableResponseByRefId` only (delete line 54, the `if (legacy)` block 55-64). |
| `relay-wait$.ts` `readUnionResponse` (~150) | union legacy inbox | durable-only. |
| `relay-stream$.ts:141-148` | `hasDropped ? [] : readInboxByStreamId` + `markProcessed` settle | `readDurableResponsesByStreamId` only. |
| `bound-agent-loop.ts:1745-1757` `createClientResultWait$` | `hasDropped ? null : readInboxByRefId` + `markProcessed` | **If #260 merged, this is already `readUnionResponseEntry`** → just drops the internal legacy branch with `relay-await-helpers`. If not merged, migrate + delete here. |
| `event-payload.ts:169` `buildEventWakeupContent` | `readUnprocessedInboxByRefId` (legacy intake) unioned with durable intake | durable intake read only. Delete the legacy half; the fold reads `durable_work` intake rows only. |
| `scheduler.ts:564,1205,2149` | `hasDropped ? durable : legacy` + `markProcessed` | durable-only; delete `markProcessed(2149)`. |
| `webhook-intake-reconciler.ts:131` | `markProcessed` legacy | durable ack only. |

**`relay-processor.ts` — durable-only rewrite.** The processor keeps only `processPendingDurableWork`. Delete: the `hasDroppedLegacyRelayTables` early-return-to-durable guards (`311,391,888,1685`) become the unconditional path; the single-host loopback pass (`395-436`); `readUnprocessed`/`readUndelivered` scans; every `markProcessed` call (~18 sites: `448,618,663,692,699,710,728,756,794,845,866,933,1025,1078,1100,1132,1155`); the cancel-first-pass legacy scan (keep the durable cancel handling that already exists in the durable lane). The multipart `inference_part` legacy SELECT (`891`) → durable equivalent (verify a durable multipart reader exists; if not, that's a gap to flag — likely `readDurableResponsesByStreamId` or a kind-scoped claim).

**Tests pinning legacy reader behavior → delete/rewrite:** see §6-TESTS.

---

## §3 — BRIDGE / TRANSITION code

**`hasDroppedLegacyRelayTables` call sites — all become constant-true, delete gate + dead legacy branch:**
- `schema.ts:714` — delete gate + the CREATE-TABLE block it guards (Phase 3/4).
- `platforms/src/mcp-registry.ts:811`, `rss-poller.ts:588`, `web/webhook-handler.ts:235` — `forceDurable` collapses to always-durable; delete the `!DURABLE_INTAKE_ENABLED` warn branches.
- `scheduler.ts:564,1205` — durable-only.
- `client-tool-dispatch.ts:3` (import), body — durable-only (post-#260).
- `bound-agent-loop.ts:1745` — durable-only.
- `relay-stream$.ts:141` — durable-only.
- `relay-processor.ts:311,391,888,1685` — unconditional durable path.
- `relay-retirement.ts:108,230,263` — **file deleted entirely.**
- `core/src/relay.ts:485` (inside `hasDroppedLegacyRelayTables`'s neighbor) — deleted with the function.

**4E drain-then-drop machinery — delete, replaced by startup refusal:**
`relay-retirement.ts` in full: `DROP_LIVENESS_HORIZON_MS`, `drainLegacyRelayOutbox`, `allLivePeersAdvertiseSpool`, `maybeDropLegacyRelayTables`, `runRelayRetirementPass`, `legacyDrainIdempotencyKey`, the two counters. Delete the wiring call site (`runRelayRetirementPass` at startup boot-recovery + relay-processor periodic cadence — grep it; likely `cli/src/commands/start/*` and `relay-processor.ts`).

**Toggles:**
- `BOUND_DURABLE_RELAY` / `DURABLE_RELAY_ENABLED` (`durable-work.ts:28-35`) — **die.** Only legacy-rollback consumer.
- `BOUND_DURABLE_INTAKE` / `DURABLE_INTAKE_ENABLED` (`durable-work.ts:18-25`) — **die.** Rollback target is legacy `relay_inbox` writes, now gone.
- `BOUND_DURABLE_DISPATCH` / `DURABLE_DISPATCH_ENABLED` (`dispatch.ts:8`) — **survives** (dispatch_queue out of scope).
- `BOUND_TASK_FIRE_MODE` — **survives.**

**Migration fences for legacy null-keyed rows (migration invariant 3):** these were the drain's `legacy-relay:<id>` key derivation (`relay-retirement.ts:79-81`). Deleted with the file. No longer needed: no legacy rows are produced or drained.

**`buildEventWakeupContent` transition-only union read:** the `readUnprocessedInboxByRefId` half (`event-payload.ts:169`) — delete (§2).

---

## §4 — STARTUP REFUSAL (exact spec)

**Location:** `packages/core/src/schema.ts`, in the schema-init function (the one holding the `local_flags` CREATE at `~700` and the `legacyRelayRetired` gate at `714`), called from `createAppContext` (`app-context.ts:39`). Place the check **after** `local_flags` is created and **before** any durable_work / relay work, so a populated-legacy-table host refuses before touching anything.

**Exact check (schema-independent — the row types are being deleted, so probe `sqlite_master` raw):**
```ts
for (const table of ["relay_outbox", "relay_inbox"] as const) {
  const exists = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  if (!exists) continue; // already dropped (4E) — the healthy N→N+1 path
  const { count } = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  if (count > 0) {
    throw new Error(
      `Refusing to start: legacy relay table "${table}" still holds ${count} row(s). ` +
      `This host skipped the release-N drain-and-drop migration. ` +
      `Roll back to the release-N binary (v0.0.253-era, first version with hasDroppedLegacyRelayTables) ` +
      `and let it drain and drop the legacy tables before upgrading to this release.`
    );
  }
  // Table exists but empty: drop it here (a host that reached the 4E gate empty
  // but crashed before the drop) OR leave it — a bare empty table is harmless.
  // Recommendation: DROP IF EXISTS the empty table for cleanliness, no marker needed.
}
```
- Interpolating `table` in `COUNT(*)` is safe — it's a compile-time literal from the `as const` tuple, not user input (invariant #4 concerns interpolated *user/column* names).
- **`relay_outbox` vs `relay_inbox` vs other:** both in scope. `dispatch_queue` NOT in scope (§ decision 4) — it has no drop path and is still active. `relay_cycles` NOT in scope (telemetry, retained). Confirm no other legacy table 4B/4C left behind: grep found only `dispatch_queue` (kept) and `connector_intake` (no schema.ts CREATE — it's a `durable_work` kind, not a table). So the refusal set is exactly `{relay_outbox, relay_inbox}`.
- Name the release-N binary in the error. The version string to cite: the release that shipped `hasDroppedLegacyRelayTables` (slice 4E, commit `5aaecbd3`; check the tag it landed under — likely the v0.0.244–253 band; implementer verifies via `git tag --contains 5aaecbd3 | sort -V | head -1`).

**Test:** new `schema.test.ts` cases — (a) populated `relay_outbox` → throws with the table name and row count; (b) populated `relay_inbox` → throws; (c) empty tables present → starts (and drops them); (d) tables absent (post-4E) → starts clean.

---

## §5 — SCHEMA / TYPES

- `schema.ts:714-772` — delete `legacyRelayRetired` gate + the `if (!legacyRelayRetired) { CREATE relay_outbox … CREATE relay_inbox … 4 indexes }` block. N+1 never creates these tables.
- `schema.ts:843,848,861,877,882` — the stream_id/trace_context ALTER migrations for the legacy tables — delete (dead once tables never exist).
- `schema.ts:1088-1112` — the idempotency-index rebuild + cleanup indexes for relay_outbox/relay_inbox — delete.
- `shared/src/types.ts:673` `RelayOutboxEntry`, `:688` `RelayInboxEntry` — delete (verify no importer survives Phase 1/2; `RelayKind` and the registry stay).
- `sync/src/changeset.ts:17,20` `RelayResponse.relay_inbox` / `RelayRequest.relay_outbox` — HTTP-sync relay changeset shapes. **Verify dead first** (grep `/sync/relay`, `fetchOutboundChangeset` relay usage, `applyRelayResponse`). If the WS transport fully replaced HTTP relay, delete these wire types + their reducer wiring. If a legacy HTTP relay endpoint survives, that's a separate scope question — flag it.
- `core/src/index.ts` — prune deleted exports (`markProcessed:89`, `readInboxByRefId:91`, `readInboxByStreamId:92`, `hasDroppedLegacyRelayTables:99`, `DURABLE_INTAKE_ENABLED:157`, `DURABLE_RELAY_ENABLED:159`, `LOCAL_WORK_TARGET` stays).
- **Refusal check needs table names only** (raw `sqlite_master`), NO row-type dependency — so the type deletions and the refusal are independent. Good: the refusal survives the type deletion.

---

## §6 — TESTS + DOCS

### §6-TESTS (files exercising legacy relay paths)
**Delete entirely (legacy-only):**
- `agent/src/__tests__/relay-retirement.test.ts` (398 lines) — the drain-drop machinery is gone.
- `core/src/__tests__/relay.test.ts` — legacy CRUD (writeOutbox/insertInbox/markProcessed/read*). Keep only any `relay_cycles` telemetry cases (move to a telemetry test).

**Rewrite (legacy branch → durable-only or LOCAL_WORK_TARGET):**
- `core/src/__tests__/schema.test.ts` (810 lines) — the `hasDroppedLegacyRelayTables`/`dropLegacyRelayTables` cases (`279,295,310`) → replace with the §4 refusal cases.
- `agent/src/__tests__/relay-durable-routing.test.ts` — self-target legacy cases → LOCAL_WORK_TARGET cases; non-advertising-peer legacy-fallback cases → error cases.
- `agent/src/__tests__/relay-processor-core.test.ts`, `relay-processor-inference.test.ts`, `relay-processor-webhook.test.ts` — loopback/inbox cases → durable/LOCAL_WORK_TARGET.
- `agent/src/__tests__/relay-wait$.test.ts`, `relay-stream$.test.ts`, `relay-stream.test.ts`, `relay-stream.integration.test.ts` — union-read cases → durable-only.
- `agent/src/__tests__/relay-event-driven.test.ts`, `relay-backend.test.ts`, `relay-trace-topology.test.ts` — audit for legacy `relay:inbox` event assertions.
- `agent/src/__tests__/event-payload.test.ts` — buildEventWakeupContent union → durable intake only.
- `agent/src/__tests__/durable-intake-handoff.test.ts`, `intake-kind-registry.test.ts`, `webhook-intake-deadletter.test.ts` — drop legacy-intake fallback assertions.
- `agent/src/__tests__/client-tool-relay.integration.test.ts`, `client-result-durable-response.test.ts` (in-flight #260), `yard-client-tool-dispatch.test.ts` — durable-only.
- `agent/src/__tests__/wakeup-routing.test.ts`, `scheduler-features.test.ts`, `heal-stuck-tasks-cross-path.integration.test.ts`, `eviction-atomic.integration.test.ts` — audit for legacy markProcessed / relay_inbox.
- `sync/src/__tests__/ws-transport.test.ts` — delete hub-local inbox-insert + `handleRelaySend` insert cases; add the §7-SKEW warn-and-drop case.
- `sync/src/__tests__/telemetry.test.ts`, `core/.../telemetry.test.ts` — the `relay_outbox`/`relay_inbox` span-kind cases (`telemetry.ts:157`) → prune to `changelog` only (or whatever survives).
- `sync/src/__tests__/test-harness.ts:278` — the `CREATE TABLE relay_inbox` fixture → delete (harness no longer needs it).
- `cli/src/__tests__/remote-platform-durable-response.test.ts`, `remote-platform-trace-carrier.test.ts`, `boundctl.test.ts` — durable-only awaiter.
- `platforms/src/__tests__/relay-integration.integration.test.ts`, `connector-intake.test.ts`, `connector-handle-lifecycle.integration.test.ts`, `rss-poller.test.ts` — drop legacy-intake branches.
- `web/src/server/__tests__/webhook-handler.test.ts` (`1091,1111`) — drop the `dropLegacyRelayTables`/`hasDropped` cases.
- `core/src/__tests__/durable-response-readers.test.ts`, `relay-trace-context.test.ts`, `dispatch-queue.test.ts`, `phase1.integration.test.ts` — audit; `dispatch-queue.test.ts` stays (dispatch out of scope) unless it references relay tables.

### §6-DOCS
- `packages/docs/src/content/docs/reference/durable-work-recovery.md` — delete the `BOUND_DURABLE_RELAY` (line 60) and `BOUND_DURABLE_INTAKE` (line 58) rollback sections entirely (toggles die). Keep `BOUND_DURABLE_DISPATCH` (56) and `BOUND_TASK_FIRE_MODE` (62). Line 46 legacy relay-inbox dead-letter note → prune. Update the transferring-recovery prose to drop legacy references.
- `AGENTS.md` — Delegation section: rewrite the `routeRelayRequest`/`shouldRouteRelayDurable` paragraph (remove `BOUND_DURABLE_RELAY`, the legacy-fallback description, the "self-targeted loopback stays legacy" line → replace with LOCAL_WORK_TARGET loopback). Webhook + RSS sections: remove `BOUND_DURABLE_INTAKE=0` rollback sentences and the "union of durable_work and legacy relay_inbox" phrasing → "durable_work intake only". The "requester awaits the union of legacy relay_inbox and durable rows" line → "awaits durable response rows".
- `docs/invariants.md#3` + CONTRIBUTING.md invariant #3 index line — already reads "durable_work / relay_cycles are local-only; legacy relay_outbox/relay_inbox are transitional and dropped per-host after the 4E gate." Update to end-state: drop "legacy relay_outbox/relay_inbox are transitional…" (they no longer exist). The spec's §7 replacement text (spec line ~30) is already the end-state wording.
- `docs/invariants.md#14` (Hub response-kind routing) — currently "hub-targeted response kinds go into relay_inbox". Rewrite: response kinds are consumed by the awaiter via the durable spool; the invariant about NOT calling `executeImmediate()` for response kinds survives but the `relay_inbox` mechanism reference changes. CONTRIBUTING index line #14 likewise.
- `docs/design/sync-protocol.md` — relay section: remove `relay_outbox`/`relay_inbox` CRUD references; keep the WS `RELAY_SEND` frame documented as version-skew-only (§7-SKEW).
- Spec `docs/design/specs/2026-08-31-durable-work-consolidation.md` — end-state per Kara's spec-hygiene rule; no N+1-process narration. The migration slices live on #253, not the spec. Do NOT add "release N+1 deleted X" prose to the spec.

---

## §7-SKEW — Version-skew frame handling (the compatibility decision)

**Frame types involved:** `WsMessageType.RELAY_SEND = 0x03` (`ws-frames.ts:13`), plus `RELAY_DELIVER`, `RELAY_ACK` (the legacy relay frame family). The spool uses `SPOOL_TRANSFER`/`SPOOL_TRANSFER_ACK` (separate frame types).

**The scenario:** an N host (has NOT dropped legacy tables, still routes some traffic legacy toward a peer it believes doesn't advertise) sends a `RELAY_SEND` frame to an N+1 host. Because **N+1 hosts advertise `work_spool_capable`**, a correctly-behaving N peer with a current `hosts` snapshot routes spool-only to it. A legacy `RELAY_SEND` reaching an N+1 host therefore implies the sender has a STALE snapshot (hasn't re-read our advertisement).

**The decision the implementer must make, and the recommendation:**

- **Do NOT delete the `RELAY_SEND` frame decode** in `ws-server.ts:430` / `ws-client.ts:630`. Deleting the enum case means an unknown frame hits the dispatch default → the ws-server closes the connection with 1011 by design (storage/invariant failure semantics), and a stale N peer would connection-flap indefinitely. Keep the decode so we can refuse the *payload* while keeping the *socket*.
- **`handleRelaySend` (`ws-transport.ts:914+`) becomes an unconditional warn-and-drop.** Delete all its routing/insert logic (broadcast fan-out, hub-local `insertInbox`, forward-to-spoke). Replace the body with: structured `logger.warn("Refusing legacy RELAY_SEND on an N+1 host; sender has a stale capability snapshot and must re-read our work_spool_capable advertisement", {sourceSiteId, kinds})`, do NOT ack (leave ids out of any deliveredIds), return. The sender's own retry/redelivery holds its row until it re-reads our synced advertisement and re-sends over the spool. Failure mode: **bounded stall, never data loss** (sender's copy survives) — exactly the release-N dropped-host refusal (`ws-transport.ts:1007-1020`), promoted from a `hasDropped`-gated branch to the unconditional behavior.
- **`RELAY_DELIVER` inbound on a spoke:** same treatment — warn-and-drop (there's no `relay_inbox` to deliver into). `RELAY_ACK`: harmless no-op (nothing to mark delivered); can warn-and-drop.

**Grounding in the spec:** R-DW14 (spec line 155) — "Transport shall send spool transfers only to peers that advertise the bit." The bit means "this binary speaks the spool protocol." An N+1 host advertises it; a peer that ignores it and sends legacy is misbehaving-but-recoverable. The spec's design intent is capability-gated routing with the receiver as the backstop (the release-N comment at `relay-retirement.ts:40-42` explicitly names "the only residual hole, a peer with a stale hosts snapshot, is handled on the receive side by the RELAY_SEND refusal"). N+1 makes that receive-side refusal the sole, unconditional behavior.

**Test:** `sync/src/__tests__/ws-transport.test.ts` — a `RELAY_SEND` frame arrives on an N+1 host → asserts (a) warn logged, (b) no `insertInbox` (table gone → would throw if attempted), (c) socket stays OPEN (no 1011), (d) no ack sent.

---

## Blast radius per package

| Package | Scope | Blast |
|---|---|---|
| `core` | `relay.ts` (delete ~15 fns), `schema.ts` (delete CREATE + gate + migrations + add refusal), `durable-work.ts` (delete 2 toggles), `index.ts` (prune exports), `changeset.ts` reducer wiring | **High** — the CRUD + schema epicenter. |
| `agent` | `relay-router.ts` (loopback rewrite + delete legacy branches), `relay-processor.ts` (durable-only, delete ~18 markProcessed + loopback pass), `relay-await-helpers.ts`/`relay-wait$.ts`/`relay-stream$.ts` (drop legacy union branch), `bound-agent-loop.ts`, `event-payload.ts`, `scheduler.ts`, `webhook-intake-reconciler.ts`, **delete `relay-retirement.ts`** | **High** — most call sites live here. |
| `sync` | `ws-transport.ts` (delete inbox inserts + hub self-routing; `handleRelaySend` → warn-drop), `ws-server.ts`/`ws-client.ts` (keep decode, verify), `changeset.ts` (verify HTTP relay dead), `telemetry.ts` (prune span kinds), `test-harness.ts` (delete inbox fixture) | **Medium-high.** |
| `platforms` | `mcp-registry.ts`, `rss-poller.ts` (delete legacy-intake branches) | **Low-medium.** |
| `web` | `webhook-handler.ts` (delete legacy-intake branch), `server/index.ts:124` (`drainRelayInbox` type — delete) | **Low.** |
| `cli` | wiring for `runRelayRetirementPass` deletion; awaiter tests | **Low.** |
| `shared` | `types.ts` (delete 2 row types) | **Low.** |
| `docs` | recovery page, AGENTS.md, invariants #3/#14, sync-protocol.md | **Low** (content). |

## Open items the implementer must verify before deleting (don't assume)
1. `sync/src/changeset.ts` HTTP-relay wire types — grep `/sync/relay`, `applyRelayResponse`, `fetchOutboundChangeset` relay usage to confirm the WS transport fully superseded HTTP relay before deleting `relay_inbox`/`relay_outbox` from the changeset. If a legacy HTTP relay endpoint survives, it's a separate scope question — flag, don't silently delete.
2. `relay-processor.ts:891` multipart `inference_part` legacy SELECT — confirm a durable-spool multipart reader exists (kind-scoped claim or `readDurableResponsesByStreamId`); if not, that's a functional gap to close in this slice, not just a deletion.
3. #260 merge status — if unmerged when this runs, Phase 2/3 absorb the two hand-rolled awaiters (scope add; flag it).
4. `runRelayRetirementPass` wiring location — grep to find every call site (startup boot-recovery + relay-processor periodic) before deleting `relay-retirement.ts`.
