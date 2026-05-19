# OpenTelemetry Distributed Tracing — Phase 5: Relay Trace Context Propagation

**Goal:** Cross-host traces — a single trace ID spans spoke and hub execution. Only the investigating operator needs OTEL enabled; remote nodes participate transparently.

**Architecture:** Spoke injects trace context via `propagation.inject()` into relay outbox entries as a `trace_context` TEXT column. Hub extracts context, activates a scoped `InMemorySpanExporter` for that execution, creates child spans under the spoke's parent, serializes buffered spans, and returns them as a `trace_data` relay response. Spoke re-exports received spans to its local collector.

**Tech Stack:** @opentelemetry/api (propagation), @opentelemetry/sdk-trace-base (InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider)

**Scope:** 6 phases from original design (phases 1-6). This is phase 5.

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### otel-tracing.AC5: Cross-host relay propagation
- **otel-tracing.AC5.1 Success:** Relay entries carry trace_context column from spoke to hub
- **otel-tracing.AC5.2 Success:** Hub creates child spans linked to the spoke's trace without OTEL_ENABLED on hub
- **otel-tracing.AC5.3 Success:** Hub returns serialized spans via trace_data relay response
- **otel-tracing.AC5.4 Success:** Spoke re-exports received spans to its local collector
- **otel-tracing.AC5.5 Success:** Multi-hop traces (A→B→C) produce a single connected trace
- **otel-tracing.AC5.6 Edge:** Null trace_context column causes no behavioral change on receiving node

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add trace_context column to relay tables and update types

**Files:**
- Modify: `packages/core/src/schema.ts` (after the existing stream_id ALTER TABLE block, ~line 559)
- Modify: `packages/shared/src/types.ts` (RelayOutboxEntry and RelayInboxEntry interfaces)
- Modify: `packages/core/src/relay.ts` (writeOutbox and insertInbox SQL)
- Modify: `packages/agent/src/relay-router.ts` (createRelayOutboxEntry signature)

**Implementation:**

**Schema migration** in `packages/core/src/schema.ts` — add after the `stream_id` try-catch blocks:

```typescript
try {
	db.run("ALTER TABLE relay_outbox ADD COLUMN trace_context TEXT");
} catch {
	/* already exists */
}
try {
	db.run("ALTER TABLE relay_inbox ADD COLUMN trace_context TEXT");
} catch {
	/* already exists */
}
```

No index needed for `trace_context` — it's only read when processing individual entries, never queried in bulk.

**Type updates** in `packages/shared/src/types.ts`:

Add `trace_context: string | null;` to both `RelayOutboxEntry` and `RelayInboxEntry` interfaces.

**CRUD updates** in `packages/core/src/relay.ts`:

Add `trace_context` to the `writeOutbox()` INSERT statement columns and VALUES placeholders (line ~46). Add to `insertInbox()` similarly (line ~111). Existing `SELECT *` queries (`readUndelivered`, `readUnprocessed`, `readInboxByStreamId`) will automatically include the new column without code changes since they return all columns.

**Constructor update** in `packages/agent/src/relay-router.ts`:

Add `traceContext?: string` as the last (9th) optional parameter to `createRelayOutboxEntry()`, include `trace_context: traceContext ?? null` in the returned object. **All existing callers** must be updated to pass `undefined` for the new parameter where trace context is not applicable. Known call sites in `relay-stream$.ts` (inference entry ~line 179, cancel entry ~line 244) and any other callers found by grep.

**Add `trace_data` to relay kind registry** in `packages/shared/src/types.ts`:

```typescript
export const RELAY_KIND_REGISTRY = {
	// ... existing kinds ...
	trace_data: { dispatch: "response" },
} as const satisfies Record<string, RelayKindMeta>;
```

**Verification:**

Run: `bun run typecheck`
Expected: No type errors.

Run: `bun test packages/core`
Expected: All existing relay tests pass with new nullable column.

**Commit:** `feat(core,shared): add trace_context column to relay tables and trace_data response kind`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create trace-collector.ts — scoped in-memory span exporter utility

**Verifies:** otel-tracing.AC5.2, otel-tracing.AC5.3

**Files:**
- Modify: `packages/shared/package.json` (add `@opentelemetry/sdk-trace-base` and `@opentelemetry/resources` dependencies)
- Create: `packages/shared/src/trace-collector.ts`
- Create: `packages/shared/src/trace-reexport.ts`
- Test: `packages/shared/src/__tests__/trace-collector.test.ts` (unit)

**Dependency note:** `trace-collector.ts` imports `BasicTracerProvider`, `InMemorySpanExporter`, `SimpleSpanProcessor` from `@opentelemetry/sdk-trace-base`. This requires adding `@opentelemetry/sdk-trace-base` and `@opentelemetry/resources` as dependencies of `packages/shared`. This deviates from the design's stated placement (SDK deps only in cli), but is necessary because the scoped collector is used by `packages/agent` (hub relay processor) and `packages/client` (client tool tracing) — both depend on shared but not cli.

**Implementation:**

Create `packages/shared/src/trace-collector.ts`:

```typescript
import { context, propagation, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface SerializedSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | undefined;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Record<string, unknown>;
	status: { code: number; message?: string };
	events: Array<{
		name: string;
		attributes?: Record<string, unknown>;
		timeUnixNano: string;
	}>;
}

/**
 * Create a scoped trace collector that buffers spans in memory.
 * Used by hub nodes processing relay requests with trace_context —
 * the hub does NOT need OTEL_ENABLED or a global provider.
 */
export function createScopedTraceCollector() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

	return {
		provider,
		/**
		 * Get a tracer from this scoped provider (not the global one).
		 */
		getTracer(name: string) {
			return provider.getTracer(name);
		},
		/**
		 * Serialize all buffered spans and shut down the provider.
		 */
		async flush(): Promise<SerializedSpan[]> {
			await provider.forceFlush();
			const spans = exporter.getFinishedSpans();
			const serialized = spans.map((span): SerializedSpan => {
				const ctx = span.spanContext();
				return {
					traceId: ctx.traceId,
					spanId: ctx.spanId,
					parentSpanId: span.parentSpanId,
					name: span.name,
					kind: span.kind,
					startTimeUnixNano: hrTimeToNano(span.startTime),
					endTimeUnixNano: hrTimeToNano(span.endTime),
					attributes: span.attributes as Record<string, unknown>,
					status: span.status,
					events: span.events.map((e) => ({
						name: e.name,
						attributes: e.attributes as Record<string, unknown> | undefined,
						timeUnixNano: hrTimeToNano(e.time),
					})),
				};
			});
			await provider.shutdown();
			return serialized;
		},
	};
}

/**
 * Extract trace context from a carrier object (W3C traceparent/tracestate format).
 * Returns the extracted context, or the current context if carrier is null.
 */
export function extractTraceContext(
	carrier: Record<string, string> | null,
): ReturnType<typeof context.active> {
	if (!carrier) return context.active();
	return propagation.extract(context.active(), carrier);
}

/**
 * Inject active trace context into a carrier object.
 * Returns null if no active span exists.
 */
export function injectTraceContext(): Record<string, string> | null {
	const span = trace.getActiveSpan();
	if (!span) return null;
	const carrier: Record<string, string> = {};
	propagation.inject(context.active(), carrier);
	if (!carrier.traceparent) return null;
	return carrier;
}

function hrTimeToNano(hrTime: [number, number]): string {
	return String(hrTime[0] * 1_000_000_000 + hrTime[1]);
}
```

Export from `packages/shared/src/index.ts`.

**Testing:**

Tests must verify:
- otel-tracing.AC5.2: Creating a scoped collector, starting spans via its tracer under an extracted parent context, produces spans with the correct parent traceId
- otel-tracing.AC5.3: `flush()` returns serialized spans with all expected fields (traceId, spanId, parentSpanId, name, attributes, events)
- `injectTraceContext()` returns `{ traceparent: "..." }` when a span is active, null otherwise
- `extractTraceContext(null)` returns current context without error

**Verification:**

Run: `bun test packages/shared/src/__tests__/trace-collector.test.ts`
Expected: All tests pass.

**Commit:** `feat(shared): add scoped trace collector utility for cross-host span propagation`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: Inject trace context into relay outbox entries on spoke

**Verifies:** otel-tracing.AC5.1

**Files:**
- Modify: `packages/agent/src/relay-stream$.ts` (where outbox entries are created, ~line 179-189)
- Test: `packages/agent/src/__tests__/relay-trace-inject.test.ts` (unit)

**Implementation:**

At the relay entry construction site in `relay-stream$.ts`, inject active trace context:

```typescript
import { injectTraceContext } from "@bound/shared";

// Where outbox entries are created:
const traceContext = injectTraceContext();

const entry = createRelayOutboxEntry(
	targetSiteId,
	sourceSiteId,
	kind,
	payload,
	timeoutMs,
	refId,
	idempotencyKey,
	streamId,
	traceContext ? JSON.stringify(traceContext) : undefined, // new param
);
```

This serializes the W3C trace context carrier `{ traceparent: "...", tracestate: "..." }` as JSON text into the `trace_context` column.

**Testing:**

Tests must verify:
- otel-tracing.AC5.1: When a span is active, relay outbox entries contain non-null `trace_context` with a valid traceparent string
- When no span is active, `trace_context` is null (graceful degradation)

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-trace-inject.test.ts`
Expected: All tests pass.

**Commit:** `feat(agent): inject trace context into relay outbox entries`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Extract trace context and activate scoped collector on hub relay processor

**Verifies:** otel-tracing.AC5.2, otel-tracing.AC5.3, otel-tracing.AC5.5, otel-tracing.AC5.6

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (executeInference and/or executeProcess methods)
- Test: `packages/agent/src/__tests__/relay-trace-hub.test.ts` (unit)

**Implementation:**

In the relay processor where inference/process requests are handled, extract trace context and activate scoped collector:

```typescript
import { context } from "@opentelemetry/api";
import { createScopedTraceCollector, extractTraceContext, type SerializedSpan } from "@bound/shared";

// In executeInference or executeProcess:
const traceContextStr = entry.trace_context;
const traceCarrier = traceContextStr ? JSON.parse(traceContextStr) as Record<string, string> : null;
const parentContext = extractTraceContext(traceCarrier);

let collectedSpans: SerializedSpan[] = [];

if (traceCarrier) {
	// Activate scoped collector — hub does NOT need OTEL_ENABLED
	const collector = createScopedTraceCollector();
	const tracer = collector.getTracer("bound.relay-hub");

	// Run the inference within the extracted parent context using the scoped provider
	await context.with(parentContext, async () => {
		const span = tracer.startSpan("relay.hub-inference");
		try {
			// ... existing inference execution code ...
			span.setStatus({ code: 1 }); // OK
		} catch (err) {
			span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
			throw err;
		} finally {
			span.end();
		}
	});

	collectedSpans = await collector.flush();
}

// After writing the normal response (result/stream_end), also write trace_data:
if (collectedSpans.length > 0) {
	this.writeResponse(entry, "trace_data" as any, JSON.stringify(collectedSpans));
}
```

When `trace_context` is null (AC5.6), the code path is unchanged — no collector is created, no extra response is written.

For multi-hop (AC5.5): if hub B delegates to hub C, hub B injects its own trace context into the outgoing relay entry. Hub C extracts it, creates child spans, returns them. Hub B collects its own spans + hub C's spans and returns all to spoke A.

**Testing:**

Tests must verify:
- otel-tracing.AC5.2: When entry has `trace_context`, hub creates spans under the spoke's trace (same traceId, different spanId)
- otel-tracing.AC5.3: Hub writes a `trace_data` response containing serialized spans
- otel-tracing.AC5.5: Multi-hop — verify traceId is consistent across A→B→C
- otel-tracing.AC5.6: When entry has null `trace_context`, no collector is activated, no `trace_data` response is written, execution proceeds normally

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-trace-hub.test.ts`
Expected: All tests pass.

**Commit:** `feat(agent): activate scoped trace collector on hub for relay requests with trace context`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Handle trace_data responses on spoke — re-export spans to local collector

**Verifies:** otel-tracing.AC5.4

**Files:**
- Modify: `packages/agent/src/relay-stream$.ts` (receive side — where relay responses are processed)
- Test: `packages/agent/src/__tests__/relay-trace-reexport.test.ts` (unit)

**Implementation:**

On the spoke side, when processing relay inbox responses, handle the new `trace_data` kind:

```typescript
import type { SerializedSpan } from "@bound/shared";

// In the response processing section:
if (response.kind === "trace_data") {
	const spans = JSON.parse(response.payload) as SerializedSpan[];
	reExportSpans(spans);
	// Mark as processed — trace_data is fire-and-forget
	return;
}
```

The `reExportSpans` function pushes serialized spans to the OTLP exporter. Expose the exporter instance from `telemetry.ts` and call `.export()` directly with `ReadableSpan`-conformant objects.

**Step 1:** Add a `getTraceExporter()` accessor to `packages/cli/src/commands/start/telemetry.ts`:

```typescript
let exporter: OTLPTraceExporter | null = null;

export function getTraceExporter(): OTLPTraceExporter | null {
	return exporter;
}
```

Assign the exporter in `initTelemetry()` (keep the reference before passing to BatchSpanProcessor).

**Step 2:** Create `reExportSpans()` in a module accessible to both relay-stream$ and websocket handler (e.g., `packages/shared/src/trace-reexport.ts` or alongside trace-collector.ts):

```typescript
import type { SerializedSpan } from "./trace-collector.js";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";

/**
 * Re-export serialized remote spans to the local OTLP exporter.
 * Constructs ReadableSpan-conformant objects from SerializedSpan data.
 */
export function reExportSpans(
	spans: SerializedSpan[],
	exporter: SpanExporter | null,
): void {
	if (!exporter || spans.length === 0) return;

	const readableSpans: ReadableSpan[] = spans.map((s) => ({
		name: s.name,
		kind: s.kind as SpanKind,
		spanContext: () => ({
			traceId: s.traceId,
			spanId: s.spanId,
			traceFlags: 1, // sampled
			traceState: undefined,
		}),
		parentSpanId: s.parentSpanId,
		startTime: nanoToHrTime(s.startTimeUnixNano),
		endTime: nanoToHrTime(s.endTimeUnixNano),
		status: { code: s.status.code as SpanStatusCode, message: s.status.message },
		attributes: s.attributes,
		links: [],
		events: s.events.map((e) => ({
			name: e.name,
			attributes: e.attributes ?? {},
			time: nanoToHrTime(e.timeUnixNano),
			droppedAttributesCount: 0,
		})),
		duration: nanoToHrTime(
			String(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)),
		),
		ended: true,
		resource: Resource.empty(),
		instrumentationLibrary: { name: "bound.remote-reexport" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	}));

	exporter.export(readableSpans, () => {
		// Fire and forget — export failures are non-critical
	});
}

function nanoToHrTime(nanoStr: string): [number, number] {
	const nano = BigInt(nanoStr);
	const seconds = Number(nano / 1_000_000_000n);
	const nanos = Number(nano % 1_000_000_000n);
	return [seconds, nanos];
}
```

**Step 3:** In relay-stream$.ts receive handler, call `reExportSpans` with the global exporter:

```typescript
import { reExportSpans } from "@bound/shared";
import { getTraceExporter } from "../../cli/src/commands/start/telemetry.js";
// OR pass the exporter as a dependency via constructor/config

if (response.kind === "trace_data") {
	const spans = JSON.parse(response.payload) as SerializedSpan[];
	reExportSpans(spans, getTraceExporter());
	return;
}
```

**Note on dependency flow:** `getTraceExporter()` lives in `packages/cli` which depends on `packages/agent`. To avoid circular imports, pass the exporter reference through the relay processor's constructor config or a module-level setter (similar to existing `setChangelogEventBus` pattern).

**Testing:**

Tests must verify:
- otel-tracing.AC5.4: When a `trace_data` response is received, the serialized spans are passed to the exporter for re-export
- When OTEL is not enabled (no exporter), trace_data responses are silently ignored

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-trace-reexport.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing relay tests pass (no regressions).

**Commit:** `feat(agent): re-export hub trace spans to local collector on spoke`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->
