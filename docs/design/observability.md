# Observability

Last verified: 2026-08-26

OpenTelemetry tracing and metrics across process binaries (`bound`, `boundless`, `boundctl`) and the relay protocol. Telemetry is opt-in via `OTEL_ENABLED=1`; when unset, the OpenTelemetry API returns no-op spans and instruments. When enabled, OTLP/HTTP exporters send both signals to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`). Signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` override the full exporter URL.

## Bootstrap

`initTelemetry(serviceName, options?)`, `shutdownTelemetry()`, `meter()`, `counter()`, and `histogram()` are exported from `@bound/shared`. The shared package owns tracing and metrics SDK providers, AsyncLocalStorage context propagation, OTLP/HTTP exporters, and process-wide registration. Each binary calls `initTelemetry` at startup with its own service name:

- `bound` — Phase 0 of `runStart()` in `@bound/cli`, before bootstrap
- `boundless` — Step 0 of `boundless.tsx`

The default bootstrap registers a `BasicTracerProvider` with `BatchSpanProcessor` and a `MeterProvider` with `PeriodicExportingMetricReader`. Both providers share one resource carrying `service.name` plus the process and host attributes from `Resource.default()`. `shutdownTelemetry()` shuts down both providers, flushing pending spans and metrics, then clears global API registrations. Repeated shutdown is safe.

Tests and embedders can pass `{ enabled, traceExporter, metricReader, resourceAttributes }`. The positional `SpanExporter` overload remains supported for existing callers. Injecting test exporters avoids network I/O while exercising the same providers and resource.

### Bun 1.4 auto-instrumentation compatibility

Bun 1.4 explicitly advertises compatibility for the npm packages
`@opentelemetry/instrumentation-http` and `@opentelemetry/instrumentation-fs`, including the
`shimmer` and `require-in-the-middle` patching hooks they use. That support is narrower than
Node's complete auto-instrumentation catalog:

- `instrumentation-http` patches `node:http` / `node:https`. Bound's production listeners use
  `Bun.serve`, and production outbound requests use Bun's global `fetch`; neither path crosses
  `node:http`. The sole repository `node:http` server is a development script under
  `packages/web/scripts/`.
- `instrumentation-fs` patches `node:fs`, but filesystem calls are high-volume implementation
  details here. Automatically emitting one span per call would be noisy and would overlap the
  existing operation-level spans (`hydrate-fs`, sandbox commands, config/context assembly).
- `instrumentation-undici` is not one of the two packages named by Bun's compatibility claim.
  Bun's global `fetch` is native and is not the npm `undici` module, so Undici instrumentation
  does not cover Bound's actual fetch calls.
- Bun-native APIs (`Bun.serve`, `Bun.file`, `Bun.write`, `bun:sqlite`) have no compatible npm
  auto-instrumentation package. They require intentionally placed domain or boundary spans.

This was checked on Bun 1.4.0 with both Bound's OpenTelemetry 1.30/0.57 generation and the
current 2.10/0.221 generation. Isolated preload probes registered in-memory exporters before
application imports, then exercised a `node:http` client/server pair and a global `fetch` call.
Neither probe exported a span in this runtime/build. That negative result does not contradict
Bun's package-loading compatibility claim, but it means the current Bound bootstrap cannot rely
on those packages without a repository-level span-producing integration test.

Bound therefore registers no auto-instrumentation package. Adding the broad
`@opentelemetry/auto-instrumentations-node` bundle would add dependency and patching surface
without useful production coverage. Reconsider `instrumentation-http` only if production traffic
moves through `node:http`, and reconsider fetch coverage when Bun documents and tests an
instrumentation hook for its native fetch. Any future integration belongs in this shared
bootstrap and must prove emitted spans under the pinned Bun version before it is enabled.

Bound still registers providers explicitly so manual instrumentation shares one global tracer and
meter provider rather than constructing SDKs at domain call sites.

### Metric API

Domain packages import instruments from `@bound/shared`, not SDK providers or exporters:

```ts
import { counter, histogram, meter } from "@bound/shared";

const jobsStarted = counter("bound.scheduler.jobs.started", {
	description: "Scheduled jobs started",
});
const jobDuration = histogram("bound.scheduler.job.duration", { unit: "ms" });
const schedulerMeter = meter("bound.scheduler");

jobsStarted.add(1, { "bound.task.type": task.type });
jobDuration.record(elapsedMs, { "bound.task.type": task.type });
```

`meter(name?, version?)`, `counter(name, options?)`, and `histogram(name, options?)` cache stable API objects. Before telemetry is enabled they are safe no-ops. Counter and histogram helpers use the default `bound` meter; use `meter()` directly for observable gauges or package-specific instrumentation scopes. Metric attributes must remain low-cardinality: IDs belong in traces or logs, not metric dimensions.

### Site ID span tag (`bound.site_id`)

Every span is stamped with the **executing host's site ID** as the `bound.site_id` span attribute (issue #152), so a trace store fed by multiple hosts — or one that ingests re-exported remote spans (see cross-host propagation below) — can tell which site actually ran a given loop. A trace consumer (e.g. an OTel-querying MCP server) filters on `bound.site_id` to scope "loops this host can introspect" rather than assuming every collected trace is local.

It is a *span* attribute, not a resource attribute, on purpose: resource attributes are dropped when a span is serialized and re-exported (`reExportSpans` builds a fresh `service.name: "bound-client"` resource), whereas span attributes survive `serializeReadableSpan` → `reExportSpans` on the wire. So a delegated-inference span re-exported on the requesting spoke arrives tagged with the *hub's* site ID.

Wiring: `SiteIdSpanProcessor` (in `@bound/shared`) stamps the tag on span start. The global provider's processor is populated via `setTelemetrySiteId(siteId)` — called in `runStart()` right after bootstrap derives the site ID from the host keypair, since `initTelemetry` runs at Phase 0 before the site ID exists (spans started in that startup window carry no tag, which is fine — they are infra spans, not agent loops). Hub-side relay inference passes the executing site ID into `createScopedTraceCollector(siteId)` so its spans carry it before serialization.

## Instrumentation layers

All layers use `@opentelemetry/api` directly; no auto-instrumentation.

| Tracer | Spans |
|--------|-------|
| `bound.agent-loop` | Per-turn spans, per-state child spans (`hydrate-fs`, `assemble-context`, `llm-call`, `tool-execute`), plus `agent.handle-message` and `tool.dispatch` (see below) |
| `bound.web` | `web.handle-message` per handler invocation (NOT a root span when `agent.handle-message` is open) |
| `bound.scheduler` | `scheduler.execute-task` root span per scheduled task execution |
| `bound.relay` | `relay.execute-process` root span for delegated inference on hub |
| `bound.yard` | `yard.run` per Yard execution (root + nested, linked by `yard.trace_id`), `yard.effect` per dispatched tool/inference effect |

## Cross-handler-invocation spans

The unit "one user message → final assistant response, including all tool round-trips" can span multiple `web.handle-message` invocations whenever a tool needs out-of-process resolution (today: WS-delivered client tools; tomorrow: web-UI client tools, MCP-bridged tools that block). To make this unit visible as one Jaeger trace, an in-memory `HandleMessageTracker` (`packages/agent/src/handle-message-tracker.ts`) owns two long-lived span families that survive across handler boundaries.

### `agent.handle-message`

One per logical message-handling cycle, keyed by `thread_id`. Opened when `handleThread` claims a batch whose trigger is a user message / notification / scheduler tick / webhook. Resumed (NOT reopened) when the trigger is `tool_result`. Closed in `maybeCloseTurn` after `acknowledgeBatch` when the close condition holds: agent loop is terminal (`yielded === false`) AND `dispatch_queue` has zero rows for the thread with `status IN ('pending','processing')`.

`client_tool_call` rows are INCLUDED in this count: they sit `pending` from the moment the agent enqueues a client tool until `handleToolResult` flips them to `acknowledged` — exactly the in-flight window that must keep the turn open. Also closed with `status = ERROR` on the catch path of `handleThread.runFn`.

### `tool.dispatch`

One per pending out-of-process tool call, keyed by `(call_id)`. Opened by the agent loop when enqueuing a client tool, parented under the thread's open `agent.handle-message`. The carrier injected into the WS `tool:call` frame is captured under this dispatch span's context, so `client-tool.execute` (re-exported from bound-client) parents under `tool.dispatch` — eliminating the lifetime inversion that existed when `agent-loop.tool-execute` was the parent (it ends synchronously while the remote tool is still running). Closed by the WS handler in `handleToolResult` after persisting the result, and by the cancellation paths in `emitToolCancel` (with `status = ERROR` and the cancel reason).

### Storage and lifecycle

`Map<thread_id, OpenTurnState>` and `Map<call_id, OpenDispatchState>`, in-memory only. Process restart wipes them; orphaned `web.handle-message` spans without a parent are survivable in Jaeger and signal the restart visually. Watchdog: 60s sweep interval, 15-min idle timeout — stuck spans close with `status = ERROR(watchdog_timeout)`. On graceful shutdown, `setupGracefulShutdown` calls `endAllOpenSpans("shutdown")` before `shutdownTelemetry()` so BatchSpanProcessor exports them on final flush.

When `agent.handle-message` is open, `web.handle-message` is parented under it (turnCtx becomes the parent context, not the inbound `client.send-message` carrier directly — the carrier is consumed by `openTurn`'s `parentContext` arg on the FIRST handler invocation only, so `agent.handle-message` itself parents under `client.send-message` when present). Subsequent handler invocations on the resumed cycle find the existing turn context via `getTurnContext` and skip the open call.

The open/resume logic and the `web.handle-message` span both wrap the delegation branch and the local-loop branch in `handleThread`. The two branches are distinguished by the `agent.execution` attribute on `web.handle-message` (`"local"` vs `"delegated"`). Delegation propagates the W3C carrier into `relay_outbox.trace_context` via `injectTraceContext` while `web.handle-message` is the active span, so the remote `relay.execute-process` flow re-exports under the local `agent.handle-message` and the whole turn — including hub-side inference — lives on one trace.

The close-condition probe lives on the tracker as `maybeCloseTurnIfIdle(db, threadId, status?, reason?)`. It runs in `handleThread.runFn` after `acknowledgeBatch`. Integration coverage in `packages/agent/src/__tests__/handle-message-tracker.integration.test.ts` pins the lifecycle (especially the `client_tool_call` keep-open semantics).

## Cross-host trace propagation (relay protocol)

- `relay_outbox.trace_context` and `relay_inbox.trace_context` columns (nullable TEXT, idempotent `ALTER TABLE` migration in `schema.ts`)
- Spoke injects W3C traceparent into relay outbox entries via `injectTraceContext()` from `@bound/shared`.
- Hub extracts parent context via `extractTraceContext()`, creates a `ScopedTraceCollector` (in-memory provider, NOT global), runs inference spans under it, flushes serialized spans as `trace_data` relay response (relay kind, dispatch: `"response"`).
- Spoke receives `trace_data`, calls `reExportSpans()` to feed `SerializedSpan[]` into the local OTLP exporter via `getTraceExporter()`.

## Client tool trace propagation (WS protocol)

- Server sends `trace_context` (JSON W3C carrier) in `tool:call` WS messages. The carrier is captured by the agent loop at `eventBus.emit("client_tool_call:created", ...)` time via `context.with(dispatchCtx, () => injectTraceContext())` where `dispatchCtx` is the `tool.dispatch` span context returned by `HandleMessageTracker.openDispatch`. The carrier is forwarded as the `traceContext` field on the event payload (`EventMap["client_tool_call:created"].traceContext: Record<string, string> | null`). The WS handler MUST NOT call `injectTraceContext()` itself — event-bus listeners run outside the emitter's OTel context, so `trace.getActiveSpan()` returns no span there. Capture at emit, forward at deliver.
- Client returns `trace_data` (serialized span array) in tool result WS messages.
- `createClientTracingSession()` exported from `@bound/client` owns one long-lived `BasicTracerProvider` per WS connection so the OTel machinery is not reconstructed per call, but emits **no spans of its own**. Each `wrapToolCall` extracts `linkedCtx` from the carrier via `extractTraceContext`, and parents `client-tool.execute` directly under it (passed as the third arg to `tracer.startSpan`).
- This means `client-tool.execute.parentSpanId === tool.dispatch.spanId` and `client-tool.execute.traceId === server.traceId`. Parallel/serial sibling calls under the same `tool.dispatch` parent (one per `call_id`) share the same `agent.handle-message` grandparent — no client-side container span is needed for grouping.
- No Link emission. Jaeger's OTLP intake collapses overlapping parent + Link references into a single `FOLLOWS_FROM`, breaking the `CHILD_OF` tree rendering. Drop unconditionally so the parent reference is the only ref Jaeger sees.
- The earlier `boundless.session` span has been removed. It conflated connection lifetime with per-turn lifetime (it rolled per-traceparent), and once children parent under the server SpanContext directly, sibling grouping happens implicitly via the carrier.
- `reExportSpans` sets `service.name: "bound-client"` on the OTel `Resource` so client-tool spans show their origin in Jaeger's service filter while sharing the server's `traceId`. The server re-exports received `trace_data` spans on tool-result reception. There is no trailing `trace:flush` WS frame — every `client-tool.execute` ships on its own `span.end()` via `SimpleSpanProcessor`.

## Client-to-server trace propagation (WS `message:send`)

- The `message:send` WS schema accepts an optional `trace_context` (W3C carrier). When present, the server extracts it as the parent for the `web.handle-message` root span, making server-side processing a child of the client-initiated trace rather than a fresh root.
- `EventMap["message:created"]` carries the optional `trace_context`. `handleThread()` accepts an optional `traceContext` and uses it for the root span.
- `BoundClient.sendMessage` opens a `client.send-message` span around the send and runs `injectTraceContext()` + `sendWsMessage()` inside that span's context. The span is short (local prep + WS write) but its context propagates to every server-side span the message triggers, so per-turn traces are rooted on the client. Combined with `initTelemetry("boundless")`, boundless produces full client→server trace trees; clients without OTel initialization send `trace_context: null` and the server starts a fresh root.

## Logger enrichment

Pino mixin injects `trace_id`, `span_id`, `trace_flags` into every log line when an active OTEL span exists. Enables log-to-trace correlation.

## Key exports

- From `@bound/shared`: `createScopedTraceCollector`, `extractTraceContext`, `injectTraceContext`, `runInTraceContext`, `SerializedSpan`, `setTraceExporter`, `getTraceExporter` (the last two via a module-level holder that avoids circular imports).
- From `@bound/client`: `createClientTracingSession`.
- From `@bound/agent`: `HandleMessageTracker`, `DEFAULT_WATCHDOG_TIMEOUT_MS`, `DEFAULT_WATCHDOG_INTERVAL_MS`.

---

## Metrics Dashboard

The Bound web UI includes a comprehensive Metrics tab that aggregates and visualizes token usage, cost, relay performance, and context assembly efficiency. All metrics are filtered by an interactive date range selector with presets (24h/7d/30d/All) and custom date inputs. The dashboard is backed by a single parameterized aggregation endpoint that performs server-side queries across the `turns`, `relay_cycles`, and `context_debug` data sources.

### API Endpoint

`GET /api/metrics?from=<ISO>&to=<ISO>` returns a structured `MetricsResponse` payload containing three sections: tokens, relay, and context. The endpoint enforces query parameter validation (ISO 8601 date strings required) and returns 400 with a descriptive error if parameters are missing or malformed.

**Bucketing logic** lives server-side: ranges ≤48h use hourly buckets via SQLite's `strftime('%Y-%m-%dT%H:00', created_at)`, ranges >48h use daily buckets via `date(created_at)`. The threshold is computed from the difference between `from` and `to` timestamps at request time, so the client receives appropriately granular timeline data without needing to specify bucketing strategy.

### Token Usage and Cost

The tokens section aggregates per-model token consumption and cost from the `turns` table. `byModel` returns an array with `model_id`, summed `tokens_in`/`tokens_out`/`cache_read`/`cache_write`, total `cost_usd`, and `turn_count`. The `timeline` array provides bucketed time-series data showing tokens and cost over the selected range. The `totals` object rolls up aggregate counts including `error_count` (turns with null `model_id` or other failure indicators). Cost calculation incorporates all four pricing dimensions: input tokens, output tokens, cache write tokens, and cache read tokens, using the per-million rates from `model_backends.json`.

### Relay Performance

The relay section aggregates from the local-only `relay_cycles` table, which records each relay inference request/response cycle with latency, success/failure status, and peer metadata. `byHost` returns per-host breakdowns with `avg_latency_ms`, `p95_latency_ms` (95th percentile), and success/failure/expired counts. `recentCycles` returns the 50 most recent relay cycles with sortable columns for interactive exploration. The `totals` object includes cluster-wide `success_rate` and `avg_latency_ms`. Because `relay_cycles` is not synced across hosts, the relay section reflects what the current node observes, not cluster-wide relay health — this is noted in the section header subtitle in the UI.

### Context Assembly Metrics

The context section extracts metrics from the `context_debug` JSON column on the `turns` table. `totals` provides `avg_cache_hit_rate` (percentage of tokens served from prompt cache), `budget_pressure_count` (number of turns where context size approached the model's token limit, triggering enrichment reduction or truncation), and `avg_truncated_tokens` (average number of tokens removed from history due to budget pressure). The `timeline` array shows cache hit rate and budget pressure percentage evolving over the selected date range, enabling operators to identify trends in context efficiency. Turns without `context_debug` entries are excluded from these metrics to avoid NaN or divide-by-zero errors.

### Response Contract

The full `MetricsResponse` shape includes nested objects and arrays for all three sections. The client-side view component fetches this endpoint on mount and whenever the date range changes, then passes the response sections to LayerCake-based chart components for visualization. The UI provides MetroCard summary components for key metrics (total tokens, total cost, success rate, cache hit rate), horizontal bar charts for per-model and per-host breakdowns, timeline/area charts for cost and cache evolution, and a DataTable for recent relay cycles with failure row accents. The layout follows the Tokyo Metro aesthetic with Space Grotesk typography and 8px border-radius cards, matching existing views like NetworkStatus and Timetable. Front-end visualization details are documented in the web-ui reference doc; this section covers only the backend aggregation API and metrics definitions.
