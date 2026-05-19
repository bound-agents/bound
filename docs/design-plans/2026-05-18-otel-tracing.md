# OpenTelemetry Distributed Tracing Design

## Summary

This design adds OpenTelemetry distributed tracing to bound, enabling operators to visualize execution flow across the agent loop state machine, context assembly pipeline, tool dispatch, and cross-host relay inference. The system uses manual instrumentation (auto-instrumentation is not viable on Bun) with spans exported to a local Jaeger instance via OTLP HTTP. Tracing is gated behind `OTEL_ENABLED` — when disabled, the no-op API design of `@opentelemetry/api` guarantees zero overhead. When enabled, every agent turn produces a span tree showing per-stage timing for context assembly (8 stages + 5.5), LLM driver calls with time-to-first-token events, and individual tool executions.

The key architectural choice is **cross-host trace propagation without requiring OTEL configuration on remote nodes**. When a spoke delegates inference to a hub via the relay protocol, the spoke injects trace context into the relay entry. The hub activates a scoped in-memory span exporter for that execution only, buffers spans, serializes them into a `trace_data` relay response, and returns them to the spoke, which re-exports them to its local Jaeger. This "activated pattern" means only the investigating operator needs OTEL enabled — the rest of the cluster participates transparently. The same pattern applies to client tools like boundless, where execution spans are buffered on the client and returned alongside tool results. Pino logs gain trace correlation fields (`trace_id`, `span_id`) via a mixin that reads from the active span, tying structured logs to spans in a single Jaeger view.

## Definition of Done

Add OpenTelemetry distributed tracing to bound in three phases: (1) OTEL SDK initialization in `packages/cli` with manual instrumentation of the agent loop state machine, context assembly stages, tool dispatch, and scheduler/cron triggers, (2) cross-host trace context propagation through the relay protocol so a single trace spans spoke-to-hub inference delegation without requiring OTEL configuration on remote nodes, and (3) Pino log correlation with trace IDs via a custom Pino mixin that injects `trace_id`/`span_id` from the active span.

The feature is gated behind `OTEL_ENABLED` env var. When enabled, spans export to a local Jaeger instance via OTLP HTTP. When disabled, zero overhead (no-op). Existing `Date.now()` timing code is replaced by span-derived durations. The `relay_cycles` table remains as a separate health audit mechanism. All instrumentation is manual (auto-instrumentation is not viable on Bun). When Bun ships native OTEL support (PR #28968), HTTP in/out spans will come for free without code changes.

**Explicitly out of scope:**
- No web UI trace viewer in bound
- No `@opentelemetry/auto-instrumentations-node` (broken on Bun)
- No changes to the `turns` table schema
- No permanent collector infrastructure

## Acceptance Criteria

### otel-tracing.AC1: Feature gate and initialization
- **otel-tracing.AC1.1 Success:** With OTEL_ENABLED=1 and Jaeger running, spans are exported to the configured endpoint
- **otel-tracing.AC1.2 Success:** OTEL_EXPORTER_OTLP_ENDPOINT overrides the default collector URL
- **otel-tracing.AC1.3 Success:** Without OTEL_ENABLED, startup is unaffected and no spans are exported
- **otel-tracing.AC1.4 Success:** shutdownTelemetry() flushes pending spans before process exit
- **otel-tracing.AC1.5 Failure:** Missing/unreachable collector does not crash the process (exports fail silently)

### otel-tracing.AC2: Agent loop and context assembly spans
- **otel-tracing.AC2.1 Success:** Each agent turn produces a root span with child spans for each state transition
- **otel-tracing.AC2.2 Success:** Context assembly produces per-stage child spans (stages 1-8 + 5.5)
- **otel-tracing.AC2.3 Success:** Warm vs cold cache path is recorded as a span attribute on assemble-context
- **otel-tracing.AC2.4 Success:** Token counts and model ID are recorded as span attributes after LLM response
- **otel-tracing.AC2.5 Success:** Existing Date.now() timing variables are removed without affecting other functionality

### otel-tracing.AC3: LLM driver and tool spans
- **otel-tracing.AC3.1 Success:** Each LLM chat() call produces a child span under agent-loop.llm-call
- **otel-tracing.AC3.2 Success:** Time-to-first-token and completion are recorded as span events
- **otel-tracing.AC3.3 Success:** Each tool execution produces a child span with tool.name and tool.kind attributes
- **otel-tracing.AC3.4 Failure:** Tool execution errors set span status to ERROR with error message

### otel-tracing.AC4: Entry point root spans
- **otel-tracing.AC4.1 Success:** Scheduler-triggered loops produce traces rooted at scheduler.execute-task
- **otel-tracing.AC4.2 Success:** Web UI messages produce traces rooted at web.handle-message
- **otel-tracing.AC4.3 Success:** Webhook invocations produce traces rooted at webhook.receive
- **otel-tracing.AC4.4 Success:** Platform connector events produce traces rooted at connector.event-delivery

### otel-tracing.AC5: Cross-host relay propagation
- **otel-tracing.AC5.1 Success:** Relay entries carry trace_context column from spoke to hub
- **otel-tracing.AC5.2 Success:** Hub creates child spans linked to the spoke's trace without OTEL_ENABLED on hub
- **otel-tracing.AC5.3 Success:** Hub returns serialized spans via trace_data relay response
- **otel-tracing.AC5.4 Success:** Spoke re-exports received spans to its local collector
- **otel-tracing.AC5.5 Success:** Multi-hop traces (A→B→C) produce a single connected trace
- **otel-tracing.AC5.6 Edge:** Null trace_context column causes no behavioral change on receiving node

### otel-tracing.AC6: Client tool tracing
- **otel-tracing.AC6.1 Success:** Client tool dispatch includes trace_context when a span is active
- **otel-tracing.AC6.2 Success:** Client returns trace_data with buffered spans alongside tool_result
- **otel-tracing.AC6.3 Success:** Server re-exports client spans to local collector
- **otel-tracing.AC6.4 Edge:** Client that ignores trace_context still works (tool call/result unaffected)

### otel-tracing.AC7: Pino log correlation
- **otel-tracing.AC7.1 Success:** Log records include trace_id and span_id when emitted within an active span
- **otel-tracing.AC7.2 Success:** Log records have no trace fields when no span is active
- **otel-tracing.AC7.3 Success:** Log records have no trace fields when OTEL is disabled

## Glossary

- **OpenTelemetry (OTEL)**: Vendor-neutral observability framework providing APIs and SDKs for distributed tracing, metrics, and logs. The API layer (`@opentelemetry/api`) returns no-op spans when no provider is registered, making it safe to use unconditionally in library code.
- **Span**: A unit of work in a distributed trace, representing a single operation with a start time, end time, attributes, and events. Spans nest to form a trace tree.
- **Trace context**: Serialized span metadata (trace ID, span ID, flags) propagated across process/network boundaries. Allows remote systems to create child spans under the same logical trace.
- **OTLP (OpenTelemetry Protocol)**: Wire protocol for exporting telemetry data. Supports gRPC and HTTP transports; this design uses HTTP to `http://localhost:4318` by default.
- **Jaeger**: Open-source distributed tracing backend and UI. Ingests OTLP spans and provides a timeline visualization of trace trees.
- **TracerProvider**: OTEL SDK component that manages span creation and export. Registered once at startup; all `trace.getTracer()` calls use this provider.
- **BatchSpanProcessor**: OTEL SDK component that buffers spans and exports them in batches, reducing network overhead compared to immediate export.
- **No-op span**: A span implementation that performs no work — no allocation, no recording, no export. The OTEL API returns no-ops when `OTEL_ENABLED` is unset, ensuring zero overhead.
- **Time-to-first-token (TTFT)**: Latency between LLM request submission and the first streamed token. A span event in driver instrumentation.
- **Pino**: Structured JSON logger used throughout bound. Supports mixins (functions that inject fields into every log record).
- **Relay protocol**: Bound's cross-host inference delegation mechanism. Spoke nodes write `relay_outbox` entries, the sync protocol delivers them to hub nodes, hub processes inference and writes `relay_inbox` responses, which sync back to the spoke.
- **Scoped exporter**: An in-memory span exporter activated only for a single execution context (e.g., one relay inference call). Buffers spans, serializes them, and returns them to the caller instead of exporting to a global collector.
- **Context assembly**: Bound's 8-stage pipeline that constructs LLM input messages from database state, memory retrieval, file notifications, and volatile enrichment. Stage 5.5 (volatile enrichment) injects recent memory deltas and task digests.
- **Warm vs cold cache path**: Agent loop optimization. Warm path reuses assembled messages from the prior turn and appends only new content. Cold path runs full context assembly. Cache prediction based on time-since-last-turn selects the path.
- **Agent loop state machine**: The core execution model in `packages/agent/src/agent-loop.ts`. States include HYDRATE_FS, ASSEMBLE_CONTEXT, LLM_CALL, TOOL_EXECUTE, RESPONSE_PERSIST, etc. Each transition is instrumented as a span.
- **Client tools**: Tools executed on the WebSocket client side (e.g., `boundless_bash` in the boundless terminal client). Dispatch and result return via WS protocol.
- **Bun**: JavaScript/TypeScript runtime used throughout bound. OTEL auto-instrumentation packages are broken on Bun, necessitating manual instrumentation.

## Architecture

OpenTelemetry instrumentation distributed across existing packages with no new package introduced. `@opentelemetry/api` is added to `packages/shared` (the foundation layer all packages depend on), making span creation available everywhere at zero cost when no provider is registered. The SDK components (TracerProvider, BatchSpanProcessor, OTLPTraceExporter) live in `packages/cli` since initialization happens once at startup.

### Feature Gate

`OTEL_ENABLED` env var controls activation. When unset, `@opentelemetry/api` returns no-op spans by design (this is the API's documented contract — safe for unconditional use in library code). When set, `initTelemetry()` registers a TracerProvider with a BatchSpanProcessor exporting to `OTEL_EXPORTER_OTLP_ENDPOINT` (defaults to `http://localhost:4318`). No custom config schema changes needed — standard OTEL env vars handle configuration.

### Span Creation Pattern

Instrumented code imports `@opentelemetry/api` directly and creates spans unconditionally:

```typescript
import { trace, context } from "@opentelemetry/api";
const tracer = trace.getTracer("bound.agent");

const span = tracer.startSpan("agent-loop.turn");
// ... work ...
span.end();
```

No wrapper functions, no conditional branches. The OTEL API handles the no-op case internally.

### Cross-Host Trace Propagation (Activated Pattern)

Remote nodes do NOT need `OTEL_ENABLED` or a collector. When a relay entry carries a `trace_context` column value, the receiving node activates a scoped in-memory span exporter for that execution only. After completion, buffered spans are serialized and returned via a `trace_data` relay response to the originating node, which re-exports them to its local collector. Only the investigating node needs OTEL enabled and a Jaeger instance running.

### Client Tool Tracing

The WebSocket client tool dispatch protocol gains optional `trace_context` (on tool_call) and `trace_data` (on tool_result) fields. Any WS client that implements these fields gets full trace visibility. Clients that ignore them degrade gracefully — the server still has a wall-clock span for the tool execution wait.

### Dependency Placement

| Package | New dependencies |
|---------|-----------------|
| `packages/shared` | `@opentelemetry/api` |
| `packages/cli` | `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` |

All other packages (`agent`, `llm`, `web`, `less`) gain access to `@opentelemetry/api` transitively through `@bound/shared`.

## Existing Patterns

### AsyncLocalStorage for context propagation

`loopContextStorage` in `packages/sandbox/src/commands.ts` already propagates `threadId`/`taskId` through the agent loop via `AsyncLocalStorage`. OTEL's `context.with()` uses a separate AsyncLocalStorage instance internally — the two coexist without interference. No modification to `loopContextStorage` needed.

### Relay column additions via idempotent ALTER TABLE

The `stream_id TEXT` column on `relay_outbox` and `relay_inbox` was added via idempotent `ALTER TABLE` blocks in `packages/core/src/schema.ts` (lines 545-565). The `trace_context TEXT` column follows this exact pattern.

### writeOutbox() entry construction

`createRelayOutboxEntry()` → `writeOutbox()` in `relay-stream$.ts:179-189`. The entry is constructed as a typed object before the write call — adding `trace_context` is a field addition at the construction site.

### Pino logger creation

`createLogger(pkg, component)` in `packages/shared/src/logger.ts` creates child loggers via `getRootLogger().child()`. Pino supports a `mixin` function at root logger creation time that injects fields into every log record. No existing mixin is configured — adding one is non-breaking.

### Entry points into the agent loop

Five distinct paths create agent loops: scheduler (`scheduler.ts`), web handlers (`packages/web`), relay processor (`relay-processor.ts`), platform event delivery, and webhook ingestion. All paths ultimately call `agentLoopFactory(config)` → `agentLoop.run()`.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: SDK Initialization and Logger Mixin

**Goal:** OTEL infrastructure in place — TracerProvider registers when `OTEL_ENABLED` is set, Pino logs include trace correlation fields.

**Components:**
- `@opentelemetry/api` dep added to `packages/shared/package.json`
- SDK deps added to `packages/cli/package.json`
- `packages/cli/src/commands/start/telemetry.ts` — `initTelemetry(serviceName: string)` and `shutdownTelemetry()` functions
- `packages/shared/src/logger.ts` — Pino mixin that injects `trace_id`/`span_id`/`trace_flags` from active span
- `packages/cli/src/commands/start/index.ts` — call `initTelemetry()` early in startup, `shutdownTelemetry()` in SIGTERM handler

**Dependencies:** None (first phase)

**Done when:** With `OTEL_ENABLED=1` and Jaeger running, the process starts without errors and exports a service registration. Log lines include `trace_id` when a span is active. Without `OTEL_ENABLED`, startup is unaffected and logs have no trace fields.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Agent Loop and Context Assembly Spans

**Goal:** Per-turn and per-stage timing visible in Jaeger when OTEL is enabled.

**Components:**
- `packages/agent/src/agent-loop.ts` — span per state transition (`agent-loop.turn` as root, child spans for hydrate-fs, assemble-context, llm-call, tool-execute, response-persist). Remove `turnStartTime`, `llmDurationMs`, `toolDurationMs` variables. Add span attributes: `thread.id`, `task.id`, `model.id`, `model.kind`, `context.cache_path`, token counts.
- `packages/agent/src/context-assembly.ts` — span per stage (`context.stage-1-message-retrieval` through `context.stage-8-metric-recording`). Stage 5.5 gets its own span.

**Dependencies:** Phase 1 (TracerProvider must be registerable)

**Done when:** A single agent turn produces a span tree with per-stage timing visible in Jaeger. Warm vs cold cache path is a filterable attribute. Context assembly stages show individual durations.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: LLM Driver and Tool Dispatch Spans

**Goal:** LLM inference and tool execution visible as child spans with meaningful events and attributes.

**Components:**
- `packages/llm/src/drivers/anthropic-driver.ts` — span wrapping `chat()` call, span events for time-to-first-token and completion
- `packages/llm/src/drivers/bedrock-driver.ts` — same pattern
- `packages/llm/src/drivers/openai-driver.ts` — same pattern
- `packages/agent/src/agent-loop.ts` (tool dispatch section) — span per `tool.execute()` with `tool.name` and `tool.kind` attributes

**Dependencies:** Phase 2 (spans must nest correctly under agent-loop.llm-call and agent-loop.tool-execute)

**Done when:** Jaeger shows LLM call duration with TTFT event markers. Each tool execution is a distinct span with tool name visible. Driver spans are children of agent-loop.llm-call.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Root Spans for All Entry Points

**Goal:** Every path into the agent loop produces a root span, giving end-to-end visibility regardless of how the loop was triggered.

**Components:**
- `packages/agent/src/scheduler.ts` — root span `scheduler.execute-task` wrapping `agentLoop.run()` with task.id, task.name, task.trigger attributes
- `packages/web/src/server/` (routes and WS handler) — root span `web.handle-message` for user messages
- `packages/web/src/server/` (webhook route) — root span `webhook.receive` at `POST /webhook/:name`
- Platform event delivery path — root span `connector.event-delivery` when platform events trigger agent loops

**Dependencies:** Phase 2 (agent loop spans must exist as children)

**Done when:** Traces in Jaeger start from the correct entry point regardless of trigger (cron, web message, webhook, platform event). Each trace carries contextual attributes identifying the trigger.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Relay Trace Context Propagation

**Goal:** Cross-host traces — a single trace ID spans spoke and hub execution.

**Components:**
- `packages/core/src/schema.ts` — idempotent `ALTER TABLE relay_outbox ADD COLUMN trace_context TEXT` and same for `relay_inbox`
- `packages/core/src/relay.ts` — `writeOutbox()` and `createRelayOutboxEntry()` accept and store `trace_context`
- `packages/shared/src/types.ts` — `RelayOutboxEntry` type gains optional `trace_context` field
- `packages/agent/src/relay-stream$.ts` — inject active trace context via `propagation.inject()` when creating outbox entries
- `packages/shared/src/trace-collector.ts` — scoped in-memory span exporter (create, buffer spans, serialize, flush)
- `packages/agent/src/relay-processor.ts` — extract trace context from inbox entry, activate scoped exporter when `trace_context` is present, execute inference within extracted context, serialize buffered spans into `trace_data` relay response
- New relay response kind `trace_data` in `packages/shared/src/types.ts`
- `packages/agent/src/relay-stream$.ts` (receive side) — handle `trace_data` responses, re-export spans to local provider

**Dependencies:** Phase 4 (root spans must exist to inject from), Phase 1 (provider for re-export)

**Done when:** With OTEL enabled on spoke only, a relay-delegated inference produces a single trace in Jaeger showing both spoke-side context assembly and hub-side inference execution. Hub requires no OTEL configuration.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Client Tool Tracing Protocol

**Goal:** Client tool execution (boundless, future clients) produces child spans visible in the server's Jaeger.

**Components:**
- WS protocol types (in `packages/web` or `packages/shared`) — add optional `trace_context: string` to tool_call dispatch, optional `trace_data: string[]` to tool_result response
- `packages/web/src/server/` (WS handler, tool dispatch) — inject `trace_context` from active span when dispatching client tools
- `packages/web/src/server/` (WS handler, tool result) — re-export `trace_data` spans when received
- `packages/client/src/tracing.ts` — `withClientToolTracing(traceContext, fn)` helper using `trace-collector.ts`
- `packages/less/` — implement `trace_data` return using `withClientToolTracing()` for boundless_bash and other client tools

**Dependencies:** Phase 5 (`trace-collector.ts` shared utility), Phase 2 (tool-execute spans to nest under)

**Done when:** A client tool execution (e.g., boundless_bash running tests) appears as a child span in the server's trace. Clients without tracing support still work unchanged (graceful degradation).
<!-- END_PHASE_6 -->

## Additional Considerations

**Bun compatibility:** `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` work on Bun but are not officially supported. Pin versions and test after Bun upgrades. Bun PR #28968 (native OTEL support) would give HTTP auto-instrumentation for free when it lands — no code changes needed since `initTelemetry()` already registers a provider.

**Span naming convention:** Dot-separated lowercase, package-scoped: `agent-loop.turn`, `context.stage-5.5-volatile-enrichment`, `llm-driver.chat`. Consistent with OTEL semantic conventions for custom instrumentation.

**100% sampling:** System processes 2-3 turns per minute at peak. Sampling logic overhead exceeds the overhead of recording everything. AlwaysOnSampler is the correct choice.

**Graceful degradation across the cluster:** Trace context columns propagate regardless of OTEL state. Non-OTEL nodes store and forward `trace_context` as opaque TEXT. The scoped exporter activates only when `trace_context` is non-null, so nodes participate in traces without global configuration.

**Existing relay_cycles table:** Maintained in parallel. OTEL spans answer "what happened and how long did each piece take?" while relay_cycles answers "how many relay operations succeeded/failed in the last hour?" — different tools for different questions.
