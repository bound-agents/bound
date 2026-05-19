# OpenTelemetry Distributed Tracing — Test Requirements

Maps each acceptance criterion (AC1 through AC7) to automated tests or documented human verification procedures.

**Testing framework:** bun:test (describe/it/expect)
**OTEL test harness:** InMemorySpanExporter + SimpleSpanProcessor + BasicTracerProvider
**LLM simulation:** MockLLMBackend
**Database:** Real temp SQLite databases (randomBytes hex paths)
**File naming:** `*.test.ts` (unit), `*.integration.test.ts` (integration)

---

## AC1: Feature gate and initialization

### AC1.1 — With OTEL_ENABLED=1 and Jaeger running, spans are exported to the configured endpoint

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/cli/src/__tests__/telemetry.test.ts` |
| Description | Set `OTEL_ENABLED=1` in process.env, call `initTelemetry("bound-test")`. Create a span via `trace.getTracer("test").startSpan("test-span")`. Verify `span.isRecording()` is true. Use InMemorySpanExporter (injected in place of OTLPTraceExporter) to confirm the span appears in exported finished spans after `span.end()`. |

### AC1.2 — OTEL_EXPORTER_OTLP_ENDPOINT overrides the default collector URL

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/cli/src/__tests__/telemetry.test.ts` |
| Description | Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://custom:9999` in process.env, call `initTelemetry()`. Verify the OTLPTraceExporter is constructed with `url: "http://custom:9999/v1/traces"` (assert via spy or by exposing exporter config for test). |

### AC1.3 — Without OTEL_ENABLED, startup is unaffected and no spans are exported

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/cli/src/__tests__/telemetry.test.ts` |
| Description | Ensure `OTEL_ENABLED` is unset. Call `initTelemetry("bound-test")`. Create a span via `trace.getTracer("test").startSpan("noop")`. Verify `span.isRecording()` is false (no-op tracer). Verify no provider is registered by confirming `shutdownTelemetry()` returns immediately without error. |

### AC1.4 — shutdownTelemetry() flushes pending spans before process exit

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/cli/src/__tests__/telemetry.test.ts` |
| Description | Set `OTEL_ENABLED=1`, call `initTelemetry()` with InMemorySpanExporter. Start and end a span. Call `shutdownTelemetry()`. Verify the span is present in the exporter's finished spans (confirming flush). Verify a subsequent `trace.getTracer("test").startSpan("post-shutdown").isRecording()` returns false (provider is shut down). |

### AC1.5 — Missing/unreachable collector does not crash the process

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/cli/src/__tests__/telemetry.test.ts` |
| Description | Set `OTEL_ENABLED=1` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1` (unreachable port). Call `initTelemetry()`. Start and end a span. Verify no exceptions are thrown. Call `shutdownTelemetry()` and verify it resolves without error. |

---

## AC2: Agent loop and context assembly spans

### AC2.1 — Each agent turn produces a root span with child spans for each state transition

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/agent-loop-spans.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Create a minimal agent loop config (real temp DB, MockLLMBackend returning text response). Run one turn. Verify exported spans include `agent-loop.turn` as root (no parentSpanId) with children `agent-loop.hydrate-fs`, `agent-loop.assemble-context`, `agent-loop.llm-call`, `agent-loop.response-persist`. Verify parent-child relationships via traceId/parentSpanId. |

### AC2.2 — Context assembly produces per-stage child spans (stages 1-8 + 5.5)

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly-spans.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Start an active parent span, then call `assembleContext()` with a minimal params object (real temp DB with at least one message). Verify exported spans include `context.stage-1-message-retrieval`, `context.stage-2-purge-substitution`, `context.stage-3-tool-pair-sanitization`, `context.stage-5-annotation`, `context.stage-5.5-volatile-enrichment`, `context.stage-6-assembly`, `context.stage-7-budget-validation`, `context.stage-8-metric-recording`. Verify all are children of the parent span. |

### AC2.3 — Warm vs cold cache path is recorded as a span attribute on assemble-context

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/agent-loop-spans.test.ts` |
| Description | Run a first agent turn (cold path) and verify the `agent-loop.assemble-context` span has attribute `context.cache_path` = `"cold"`. Run a second turn in the same loop (warm path) and verify the second `agent-loop.assemble-context` span has attribute `context.cache_path` = `"warm"`. |

### AC2.4 — Token counts and model ID are recorded as span attributes after LLM response

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/agent-loop-spans.test.ts` |
| Description | Run one turn with MockLLMBackend configured to return usage tokens (input_tokens=100, output_tokens=50). Verify the `agent-loop.turn` span has attributes `model.id` (non-empty string), `llm.input_tokens` (100), `llm.output_tokens` (50). |

### AC2.5 — Existing Date.now() timing variables are removed without affecting other functionality

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/agent-loop-spans.test.ts` |
| Description | Run a complete agent turn and verify it completes without error. Verify that log output no longer contains `llmDurationMs` or `toolDurationMs` fields (grep on captured log output). Alternatively: verify that running `bun test packages/agent` passes all existing tests (regression check). |

---

## AC3: LLM driver and tool spans

### AC3.1 — Each LLM chat() call produces a child span under agent-loop.llm-call

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/llm-driver-spans.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Run one agent turn with MockLLMBackend yielding heartbeat, text, done chunks. Verify exported spans include `llm-driver.chat` as a child of `agent-loop.llm-call` (matching parentSpanId). Verify `llm-driver.chat` has attributes `llm.model` and `llm.provider`. |

### AC3.2 — Time-to-first-token and completion are recorded as span events

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/llm-driver-spans.test.ts` |
| Description | Run one turn with MockLLMBackend yielding: heartbeat, text chunk, done chunk. Verify the `llm-driver.chat` span has events: (1) `time-to-first-token` (fired on first non-heartbeat chunk), (2) `completion` with attributes `llm.input_tokens` and `llm.output_tokens` matching the done chunk usage. |

### AC3.3 — Each tool execution produces a child span with tool.name and tool.kind attributes

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-dispatch-spans.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Create a minimal tool registry with a mock builtin tool. Configure MockLLMBackend to return a tool_use response followed by text. Run one turn. Verify a `tool.execute` span exists with attributes `tool.name` matching the registered tool name and `tool.kind` = `"builtin"`. |

### AC3.4 — Tool execution errors set span status to ERROR with error message

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/tool-dispatch-spans.test.ts` |
| Description | Register a mock tool that returns `exitCode: 1` with an error message content. Run one turn that invokes this tool. Verify the `tool.execute` span has `status.code` = SpanStatusCode.ERROR and `status.message` contains the error content (truncated to 256 chars). |

---

## AC4: Entry point root spans

### AC4.1 — Scheduler-triggered loops produce traces rooted at scheduler.execute-task

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/scheduler-spans.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Create a scheduler instance with a mock agentLoopFactory that resolves immediately. Execute a task with `type: "cron"`. Verify a root span named `scheduler.execute-task` exists with `task.type` = `"cron"`, `task.id`, and `task.name` attributes. Verify it has no parentSpanId (true root). |

### AC4.2 — Web UI messages produce traces rooted at web.handle-message

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/cli/src/__tests__/web-message-spans.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Mock the `runLocalAgentLoop` function to resolve immediately. Simulate a web message handling flow (invoke the ThreadExecutor callback). Verify a root span named `web.handle-message` exists with `thread.id`, `user.id`, and `platform` attributes. |

### AC4.3 — Webhook invocations produce traces rooted at scheduler.execute-task (with task.type="event")

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/scheduler-spans.test.ts` |
| Description | Execute a task with `type: "event"` and `trigger_spec` matching a webhook event pattern. Verify the root span has `task.type` = `"event"` and `task.trigger_spec` contains the webhook event identifier. |

### AC4.4 — Platform connector events produce traces rooted at scheduler.execute-task (with task.type="event")

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/scheduler-spans.test.ts` |
| Description | Execute a task with `type: "event"` and `trigger_spec` matching a platform connector event pattern. Verify the root span has `task.type` = `"event"` and `task.trigger_spec` contains the connector event identifier. |

---

## AC5: Cross-host relay propagation

### AC5.1 — Relay entries carry trace_context column from spoke to hub

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/relay-trace-inject.test.ts` |
| Description | Register a BasicTracerProvider with InMemorySpanExporter. Start an active span. Call the relay outbox entry creation code path. Verify the resulting entry has a non-null `trace_context` field containing valid JSON with a `traceparent` key. Also test with no active span: verify `trace_context` is null. |

### AC5.2 — Hub creates child spans linked to the spoke's trace without OTEL_ENABLED on hub

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/relay-trace-hub.test.ts` |
| Description | Do NOT register a global TracerProvider (simulating hub without OTEL_ENABLED). Create a relay inbox entry with a valid `trace_context` (containing a known traceId). Call the relay processor's execution code path. Verify that the scoped collector creates spans with the same traceId as the injected parent and different spanIds. |

### AC5.3 — Hub returns serialized spans via trace_data relay response

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/relay-trace-hub.test.ts` |
| Description | Process a relay entry with non-null `trace_context`. Verify that after execution, a `trace_data` relay response is written containing a JSON array of SerializedSpan objects. Verify each serialized span has required fields: `traceId`, `spanId`, `name`, `startTimeUnixNano`, `endTimeUnixNano`, `status`. |

### AC5.4 — Spoke re-exports received spans to its local collector

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/relay-trace-reexport.test.ts` |
| Description | Create a mock exporter with a spy on its `export()` method. Call `reExportSpans()` with an array of valid SerializedSpan objects and the mock exporter. Verify `export()` was called with ReadableSpan-conformant objects matching the serialized span data. Also test with null exporter: verify no error. |

### AC5.5 — Multi-hop traces (A->B->C) produce a single connected trace

| Field | Value |
|-------|-------|
| Test type | Integration |
| Test file | `packages/agent/src/__tests__/relay-trace-hub.test.ts` |
| Description | Simulate a multi-hop scenario: create a traceId on node A, inject into entry for node B. Node B processes with scoped collector, then re-injects the same trace context into an outgoing entry for node C. Node C processes and returns spans. Verify all spans (from B and C) share the same traceId and form a connected parent-child chain. |

### AC5.6 — Null trace_context column causes no behavioral change on receiving node

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/relay-trace-hub.test.ts` |
| Description | Process a relay entry with `trace_context: null`. Verify no scoped collector is created (no spans buffered), no `trace_data` response is written, and the normal execution path completes without error. |

---

## AC6: Client tool tracing

### AC6.1 — Client tool dispatch includes trace_context when a span is active

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/web/src/__tests__/ws-trace-dispatch.test.ts` |
| Description | Register a BasicTracerProvider. Start an active span. Trigger the WS handler that dispatches a `tool:call` message. Verify the serialized WS message includes a `trace_context` field containing valid JSON with `traceparent`. Also verify that without an active span, the `trace_context` field is absent. |

### AC6.2 — Client returns trace_data with buffered spans alongside tool_result

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/client/src/__tests__/tracing.test.ts` |
| Description | Call `withClientToolTracing()` with a valid trace context string and a function that resolves successfully. Verify the returned `traceData` is a non-empty JSON string containing an array of SerializedSpan objects. Verify spans have the correct parent traceId from the injected context. Also test without trace context: verify `traceData` is undefined. |

### AC6.3 — Server re-exports client spans to local collector

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/web/src/__tests__/ws-trace-reexport.test.ts` |
| Description | Create a mock exporter. Simulate receiving a `tool:result` WS message with a valid `trace_data` field. Verify `reExportSpans()` is called with the parsed spans and the exporter. Also test with malformed `trace_data` JSON: verify no exception is thrown and the tool result is still processed. |

### AC6.4 — Client that ignores trace_context still works (tool call/result unaffected)

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/client/src/__tests__/tracing.test.ts` |
| Description | Simulate a client receiving a `tool:call` with `trace_context` set but NOT calling `withClientToolTracing()` (simulating a non-tracing client). Send a `tool:result` without `trace_data`. Verify the server processes the result normally without error. Verify the tool call/result round-trip succeeds with the `trace_data` field simply absent. |

---

## AC7: Pino log correlation

### AC7.1 — Log records include trace_id and span_id when emitted within an active span

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/logger-trace-mixin.test.ts` |
| Description | Register a BasicTracerProvider. Start an active span via `tracer.startActiveSpan()`. Emit a log line using the Pino logger. Parse the JSON output. Verify `trace_id` matches `span.spanContext().traceId`, `span_id` matches `span.spanContext().spanId`, and `trace_flags` is present. |

### AC7.2 — Log records have no trace fields when no span is active

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/logger-trace-mixin.test.ts` |
| Description | Register a BasicTracerProvider (OTEL is enabled) but do NOT start any span. Emit a log line. Parse the JSON output. Verify `trace_id`, `span_id`, and `trace_flags` fields are all absent from the log record. |

### AC7.3 — Log records have no trace fields when OTEL is disabled

| Field | Value |
|-------|-------|
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/logger-trace-mixin.test.ts` |
| Description | Ensure no TracerProvider is registered (simulating OTEL disabled). Emit a log line. Parse the JSON output. Verify `trace_id`, `span_id`, and `trace_flags` fields are all absent. This works because `trace.getActiveSpan()` returns undefined when no provider is registered (no-op API). |

---

## Human Verification

The following criteria require manual verification because they depend on external infrastructure (Jaeger UI), visual inspection of trace trees, or multi-process multi-host behavior that cannot be fully unit-tested.

### AC1.1 — End-to-end Jaeger export (visual confirmation)

| Field | Value |
|-------|-------|
| Justification | While the unit test verifies spans reach the InMemorySpanExporter, confirming that OTLP HTTP export to a real Jaeger instance works requires running Jaeger and visually inspecting the trace UI. Network encoding, Jaeger ingestion, and trace rendering are outside unit test scope. |
| Verification approach | Start Jaeger (`docker run -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one`). Set `OTEL_ENABLED=1`. Start bound. Send a message. Open Jaeger UI at `http://localhost:16686`, select service "bound", verify traces appear with the expected span tree structure. |

### AC2.1, AC2.2 — Trace tree visualization in Jaeger

| Field | Value |
|-------|-------|
| Justification | Unit tests verify span names and parent-child relationships, but the design plan's goal is "visible in Jaeger" which requires confirming the trace tree renders correctly in the Jaeger timeline view with proper nesting and timing. |
| Verification approach | With OTEL_ENABLED=1 and Jaeger running, send a message that triggers a cold context assembly. In Jaeger, select the resulting trace and verify: (1) agent-loop.turn is the root, (2) context assembly stages are nested under agent-loop.assemble-context, (3) stage durations are visible and reasonable, (4) warm vs cold is filterable via the tag search. |

### AC2.5 — Verify no regressions from timing variable removal

| Field | Value |
|-------|-------|
| Justification | Removing `turnStartTime`, `llmDurationMs`, `toolDurationMs` could subtly affect log output or metrics that depend on those values. The full regression scope across all agent tests is automated, but verifying the live log output format is reasonable requires human inspection of a running instance. |
| Verification approach | Run `bun test packages/agent` — all tests must pass (automated). Additionally, start a live instance, trigger an agent turn, and inspect the log output to confirm no undefined/NaN timing values appear and that log messages remain coherent. |

### AC3.2 — TTFT event timing in Jaeger

| Field | Value |
|-------|-------|
| Justification | Unit tests verify the event exists on the span, but confirming the TTFT event appears at the correct point in the Jaeger timeline (between span start and completion) requires visual inspection with a real LLM backend that has measurable latency. |
| Verification approach | With OTEL_ENABLED=1 and a real LLM backend (e.g., Anthropic), send a message. In Jaeger, expand the `llm-driver.chat` span and verify the `time-to-first-token` event marker appears at the expected point in the timeline (before `completion`). |

### AC4 — All entry points produce correct root spans (end-to-end)

| Field | Value |
|-------|-------|
| Justification | While unit tests verify each entry point in isolation, confirming that all trigger types (cron, web, webhook, connector event) produce distinct correct root spans in a running system requires triggering each path in production-like conditions. |
| Verification approach | With OTEL_ENABLED=1, (1) trigger a cron task (wait for schedule), (2) send a web message, (3) send a webhook POST, (4) trigger a platform connector event. In Jaeger, filter by operation name and verify each trigger type appears with correct attributes. |

### AC5.2 — Hub participates without OTEL_ENABLED (multi-host)

| Field | Value |
|-------|-------|
| Justification | True cross-host trace propagation requires two running instances (spoke + hub) communicating over the sync protocol. The unit test simulates this with in-process mocks, but real validation requires network-separated hosts. |
| Verification approach | Deploy a spoke with `OTEL_ENABLED=1` and Jaeger. Deploy a hub WITHOUT `OTEL_ENABLED`. Send a message on the spoke that triggers relay delegation to the hub. In the spoke's Jaeger, verify the trace shows both spoke-side and hub-side spans in a single connected trace tree. Confirm the hub has no local Jaeger instance and no OTEL configuration. |

### AC5.5 — Multi-hop traces (A->B->C) in production topology

| Field | Value |
|-------|-------|
| Justification | Multi-hop relay delegation (spoke -> hub -> second hub) requires a 3-node cluster which cannot be trivially set up in a unit test. The integration test simulates this in-process, but real validation needs actual network hops. |
| Verification approach | Deploy 3 nodes where A delegates to B which delegates to C. Enable OTEL on A only. Trigger a request that flows A->B->C. Verify in A's Jaeger that a single trace shows spans from all three nodes with correct parent-child nesting across hops. |

### AC6.2 — Boundless client tool tracing (end-to-end)

| Field | Value |
|-------|-------|
| Justification | While the unit test verifies `withClientToolTracing()` in isolation, confirming that boundless (the terminal coding agent) correctly returns `trace_data` during a real tool execution requires running the full boundless client connected to a bound server. |
| Verification approach | With OTEL_ENABLED=1 on the server, connect a boundless session. Trigger a tool execution (e.g., `boundless_bash` running a command). In Jaeger, verify the trace shows a `client-tool.execute` span as a child of the server's `agent-loop.tool-execute` span. |

---

## Test File Summary

| Test File | Package | AC Coverage | Type |
|-----------|---------|-------------|------|
| `packages/cli/src/__tests__/telemetry.test.ts` | cli | AC1.1-AC1.5 | Unit |
| `packages/shared/src/__tests__/logger-trace-mixin.test.ts` | shared | AC7.1-AC7.3 | Unit |
| `packages/agent/src/__tests__/agent-loop-spans.test.ts` | agent | AC2.1, AC2.3-AC2.5 | Unit |
| `packages/agent/src/__tests__/context-assembly-spans.test.ts` | agent | AC2.2 | Unit |
| `packages/agent/src/__tests__/llm-driver-spans.test.ts` | agent | AC3.1, AC3.2 | Unit |
| `packages/agent/src/__tests__/tool-dispatch-spans.test.ts` | agent | AC3.3, AC3.4 | Unit |
| `packages/agent/src/__tests__/scheduler-spans.test.ts` | agent | AC4.1, AC4.3, AC4.4 | Unit |
| `packages/cli/src/__tests__/web-message-spans.test.ts` | cli | AC4.2 | Unit |
| `packages/agent/src/__tests__/relay-trace-inject.test.ts` | agent | AC5.1 | Unit |
| `packages/agent/src/__tests__/relay-trace-hub.test.ts` | agent | AC5.2, AC5.3, AC5.5, AC5.6 | Unit + Integration |
| `packages/agent/src/__tests__/relay-trace-reexport.test.ts` | agent | AC5.4 | Unit |
| `packages/shared/src/__tests__/trace-collector.test.ts` | shared | AC5.2, AC5.3 (utility layer) | Unit |
| `packages/web/src/__tests__/ws-trace-dispatch.test.ts` | web | AC6.1 | Unit |
| `packages/client/src/__tests__/tracing.test.ts` | client | AC6.2, AC6.4 | Unit |
| `packages/web/src/__tests__/ws-trace-reexport.test.ts` | web | AC6.3 | Unit |

---

## Test Infrastructure Patterns

### Standard OTEL test setup (reusable per test file)

```typescript
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
});

afterEach(async () => {
    await provider.shutdown();
    // Reset global trace provider for isolation
    trace.disable();
});
```

### Asserting span hierarchy

```typescript
function assertParentChild(parent: ReadableSpan, child: ReadableSpan) {
    expect(child.parentSpanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
}
```

### Asserting span events

```typescript
function assertHasEvent(span: ReadableSpan, eventName: string) {
    const event = span.events.find(e => e.name === eventName);
    expect(event).toBeDefined();
    return event;
}
```
