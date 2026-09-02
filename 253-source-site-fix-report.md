# #253 final defect — `source_site` missing on durable request rows

**Repo:** `/Users/lucalc/Documents/GitHub/bound` · **Base:** HEAD `1c88f745` on `main`, tree clean at start (one untracked file: `253-consumer-leg-trace.md`). **Status:** implemented + tested, all gates green, **NOT committed** (review-first).

## Root cause

`routeRelayRequest` (`packages/agent/src/relay-router.ts:567`) and `routeRelayResponse` (`:657`) each build their durable `insertDurableWork` row **without `source_site`**, despite `params.sourceSiteId` being in scope. Every relay message routed through the durable spool therefore lands `source_site = NULL`.

The five `dispatch: "sync"` kinds (`tool_call`, `resource_read`, `prompt_invoke`, `cache_warm`, `platform_request` — `RELAY_KIND_REGISTRY` in `packages/shared/src/types.ts`) then hit the guard at `relay-processor.ts:515`:

```ts
const writesResponse = relayKind.dispatch === "sync";
if (writesResponse && !claimed.source_site) {
  deadLetterClaimedDurableWork(..., `durable ${claimed.kind} row missing source_site; response cannot be addressed`);
```

The hub claims the platform_request row, has no return address, and dead-letters it. Live symptom: 450 dead-lettered rows on the hub. **This is broader than platform_request** — every RPC request routed durably was affected; platform_request was simply the kind exercised in the incident (discord `tools/list` every 60s).

## Producer audit (all `insertDurableWork` request/response call sites)

| Site | Kind(s) | Set `source_site`? | Hits guard? | Action |
|------|---------|--------------------|-------------|--------|
| `relay-router.ts:567` `routeRelayRequest` | ALL RPC requests (platform_request, tool_call, resource_read, prompt_invoke, cache_warm, client_tool, inference, intake, notify_wakeup, cancel, …) | ❌ **missing** | yes (sync kinds) | **FIXED** — stamp `params.sourceSiteId` |
| `relay-router.ts:657` `routeRelayResponse` | result / error / client_result / trace_data / stream_chunk / stream_end | ❌ **missing** | no (responses correlate by ref_id) | **FIXED** — stamp `params.sourceSiteId` (parity / unambiguous origin) |
| `mcp-registry.ts:823` | `connector_intake` (passive) | ✅ `this.deps.siteId` | no | none — correct |
| `web/.../webhook-handler.ts:249` | `webhook_intake` (passive) | ✅ `deps.siteId` | no | none — correct |
| `relay-retirement.ts:143` | legacy-drain re-enqueue | ✅ `entry.source_site_id ?? ctx.localSiteId` | n/a | none — correct |
| `scheduler.ts:1458` | `task_fire` | ❌ (target `this.ctx.siteId`) | no (not sync-dispatch, no response) | none needed — local, no response to address |
| `dispatch.ts:44` | `dispatch_message` | ❌ (target `LOCAL_WORK_TARGET`) | no (local sentinel, no response) | none needed — local |
| `ws-transport.ts:1825` (receiver, `handleSpoolTransfer`) | any arriving row | passes `entry.source_site ?? null` | — | **backfill added** (see below) |

The three correct producers (`connector_intake`, `webhook_intake`, legacy drain) established the pattern the fix follows: stamp the producing host's own site id.

## Changes

**`packages/agent/src/relay-router.ts`** — the single fix that covers every RPC kind, because all requests/responses funnel through these two functions:
- `:577` — added `source_site: params.sourceSiteId` to the `routeRelayRequest` durable insert.
- `:670` — added `source_site: params.sourceSiteId` to the `routeRelayResponse` durable insert.

**`packages/sync/src/ws-transport.ts`** (`handleSpoolTransfer`, `:1824`) — defensive receiver-side backfill (decision below):
```ts
const backfilledSourceSite = entry.source_site ?? sourceSiteId;
if (!entry.source_site) { logger.info("WsTransport backfilled missing source_site", {...}); }
// ... insertDurableWork({ ..., source_site: backfilledSourceSite, ... })
```

## Backfill decision (item 2) — ADDED

`sourceSiteId` at `handleSpoolTransfer` is the **authenticated direct sender** of the transfer frame. The backfill is **absent-only** (`entry.source_site ?? sourceSiteId`), which makes it safe across every topology:

- **Direct sender == originator** (spoke→hub, today's only durable-transfer path): the sender *is* the origin, so backfilling a missing value with `sourceSiteId` is exactly correct.
- **Hub-forwarded / multi-hop** (A→B→C): the originator (A) already stamped `source_site` at insert — now guaranteed by the producer fix. The `??` guard can never overwrite a present value, so a legitimate multi-hop origin is preserved untouched.

**Why keep it (not just rely on the producer fix):** version-skew safety net. An **old spoke** that predates this producer fix, talking to a **new hub**, still ships `source_site = null` and would get its requests dead-lettered again. The receiver backfill closes that window with no risk, since it only fills when absent. One `info` log names each backfill so a version-skew sender is visible from logs. Given the incident cost 450 dead-letters and the backfill is provably non-destructive, the safety margin is worth the ~15 lines.

## Dead-lettered rows (item 3) — no redrive, confirmed

The 450 hub dead-letters are **inert**. The platform_request producer re-issues `tools/list` every 60s, so fresh correctly-stamped rows supersede the pile immediately. No redrive machinery added; none warranted. (The guard's own comment already notes the rows are workspool-redrivable by hand if ever needed, but that's an operator action, not code.)

## Tests (TDD — all written failing first, then made green)

**Producer (item 4a)** — `packages/agent/src/__tests__/relay-durable-routing.test.ts`:
- `(g)` `routeRelayRequest` stamps `source_site` = producing site on a durable `platform_request` row (the incident's exact kind/payload shape).
- `(g)` `routeRelayResponse` stamps `source_site` = responding site on a durable `result` row.

Both confirmed **red** before the fix (`0 pass / 2 fail`), green after.

**Backfill (item 4b)** — `packages/sync/src/__tests__/spool-transfer.test.ts`:
- backfills a **missing** `source_site` with the authenticated sender AND logs the `info` line.
- does **NOT** overwrite a **present** `source_site` (multi-hop origin preserved; no log line).

**Hub-lane positive path (item 4c)** — `packages/agent/src/__tests__/relay-processor-core.test.ts`:
- The dead-letter branch was already covered (`:2003`, "Objection 5(g)"). Added the positive path: a `platform_request` row **WITH** `source_site` passes the sync-dispatch guard — `claim_state !== "dead_letter"` and `last_error` does not contain `source_site`. (With no platform registry wired, dispatch fails and the row stays `processing` for reclaim — a *different* outcome from the guard dead-letter, which alone proves the guard let it through.) The pre-existing end-to-end test at `:1631` also exercises the full producer→dispatch→response positive path for `tool_call`.

## Gate results

| Gate | Result |
|------|--------|
| `bun test packages/core packages/sync packages/agent packages/platforms` | **4529 pass, 23 skip, 0 fail** (339 files) |
| `bun run typecheck` | clean, 12 packages |
| `bun run lint` | clean, 1252 files |

Focused: the 3 touched test files = **94 pass, 0 fail**.

## Diff summary (uncommitted)

```
 packages/agent/src/relay-router.ts                     |  9 +++
 packages/agent/src/__tests__/relay-durable-routing.test.ts | 42 ++++++++
 packages/agent/src/__tests__/relay-processor-core.test.ts  | 31 +++++
 packages/sync/src/ws-transport.ts                      | 19 ++++-
 packages/sync/src/__tests__/spool-transfer.test.ts     | 57 +++++++++++
 5 files changed, 157 insertions(+), 1 deletion(-)
```

No commit, no push — left for review.
