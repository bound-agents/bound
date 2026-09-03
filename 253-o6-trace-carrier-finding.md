# Objection 6 finding — remote-platform trace-carrier coverage: SEVERITY UPGRADE

## Verdict

Payload-/column-level trace carriage on routed platform requests was **entirely lost**
in the #253 demolition, at the **producer**, not merely on the processing path. The
deleted `remote-platform-trace-carrier.test.ts` was the only coverage that would have
caught it. The known follow-up gap (processPendingDurableWork's entry build drops
trace parentage) is downstream of a producer that never writes the carrier in the
first place.

## Where the producer stamps the carrier today

`packages/cli/src/commands/start/server.ts` — `createRemotePlatformRequest` still
computes and passes the carrier:

```ts
const routed = routeRelayRequest(deps.db, {
  targetSiteId,
  sourceSiteId: deps.siteId,
  kind: "platform_request",
  payload: JSON.stringify({ server_name, method, params, timeout_ms: 15_000 }),
  timeoutMs: 15_000,
  traceContext: serializeRelayTraceCarrier(injectRelayTraceCarrier()) ?? undefined,
  topologyRole: resolveTopologyRole(deps.optionalConfig),
});
```

## Where it is dropped

`packages/agent/src/relay-router.ts` — `routeRelayRequest` accepts
`params.traceContext` (the field exists on `RouteRelayRequestParams`, line ~485) but
its `insertDurableWork(db, {...})` call **never references it**. The inserted row is:

```
{ id, target_site_id, kind, payload, idempotency_key, expires_at, ref_id, stream_id, source_site }
```

No `trace_context`. Confirmed structurally:

1. `NewDurableWork` (`packages/core/src/durable-work.ts:56`) has **no** `trace_context` field.
2. `insertDurableWork`'s INSERT column list (`durable-work.ts:120`) is
   `(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, ref_id, source_site, received_at, stream_id)` — **no** `trace_context`.
3. The `durable_work` table (`packages/core/src/schema.ts`) has **no** `trace_context`
   column (`grep -c trace_context schema.ts` = 1, and that one hit is the retired
   legacy-relay migration comment at line 813).

So `params.traceContext` is silently discarded. Both `routeRelayRequest` and
`routeRelayResponse` accept `traceContext?: string` (lines ~485, ~611) and neither
persists it. The pre-demolition path wrote the carrier into `relay_outbox.trace_context`
(via `writeOutbox`); the durable spool has no equivalent column, so the payload-level
carrier is gone end to end.

## Consequence

Cross-host trace parentage on **every** durable relay request and response — not just
platform requests — is lost at production. A remote platform_request, remote tool call,
inference request, and their responses all route through `routeRelayRequest`/
`routeRelayResponse`; none carries its OTEL trace carrier onto the durable row. The
follow-up issue's "processPendingDurableWork drops trace parentage" is only reachable
if the row carried a carrier to begin with — it does not.

## Recommended fix (out of scope for this review-first rework)

Add a `trace_context TEXT` column to `durable_work`, thread `trace_context` through
`NewDurableWork` + `insertDurableWork`, and write `params.traceContext` in both
`routeRelayRequest` and `routeRelayResponse`. Then wire `processPendingDurableWork`'s
entry build to read `claimed.trace_context` (closing the flagged downstream gap in the
same change). This is an additive schema migration on a local-only table (`durable_work`
is non-replicated per invariant #3), so it is a `dangerouslyExecuteRawWrite`-free
`ensureColumn` migration.

## Test written

`packages/cli/src/__tests__/remote-platform-trace-carrier.test.ts` (durable rewrite).
It drives `createRemotePlatformRequest` under an active OTEL span context and asserts
the produced `durable_work` row. Two `it`s:
- one pins what DOES survive: the producer writes a `platform_request` durable row
  targeted at the fresh remote host, carrying the correct payload — GREEN;
- one documents the regression: the carrier is NOT preserved on the row (there is no
  `trace_context` column to hold it) — asserts the current broken reality with an
  explicit `// FINDING` marker so a fix flips it.
