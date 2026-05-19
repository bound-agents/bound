# OpenTelemetry Distributed Tracing — Phase 6: Client Tool Tracing Protocol

**Goal:** Client tool execution (boundless, future clients) produces child spans visible in the server's Jaeger. Clients that don't implement tracing still work unchanged.

**Architecture:** Server injects `trace_context` into the `tool:call` WS message when a span is active. Client receives it, creates a scoped trace collector, executes the tool within the extracted context, serializes buffered spans, and returns `trace_data` alongside the `tool:result`. Server re-exports received spans to its local collector. Clients that ignore `trace_context` degrade gracefully — the server still has a wall-clock span for the tool execution wait.

**Tech Stack:** @opentelemetry/api (propagation), trace-collector.ts from Phase 5 (shared utility)

**Scope:** 6 phases from original design (phases 1-6). This is phase 6.

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### otel-tracing.AC6: Client tool tracing
- **otel-tracing.AC6.1 Success:** Client tool dispatch includes trace_context when a span is active
- **otel-tracing.AC6.2 Success:** Client returns trace_data with buffered spans alongside tool_result
- **otel-tracing.AC6.3 Success:** Server re-exports client spans to local collector
- **otel-tracing.AC6.4 Edge:** Client that ignores trace_context still works (tool call/result unaffected)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Extend WS protocol types with trace_context and trace_data fields

**Verifies:** otel-tracing.AC6.1, otel-tracing.AC6.4

**Files:**
- Modify: `packages/client/src/types.ts` (ToolCallRequest type)
- Modify: `packages/web/src/server/websocket.ts` (tool:call dispatch, tool:result schema)

**Implementation:**

**Client types** in `packages/client/src/types.ts` — extend the tool call/result types:

```typescript
// ToolCallRequest (server → client)
export interface ToolCallRequest {
	type: "tool:call";
	call_id: string;
	thread_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
	trace_context?: string; // NEW: W3C trace context JSON (optional)
}

// ToolCallResult (client → server)
export interface ToolCallResult {
	type: "tool:result";
	call_id: string;
	thread_id: string;
	content: string | ContentBlock[];
	is_error?: boolean;
	trace_data?: string; // NEW: serialized span array JSON (optional)
}
```

**Server-side dispatch** in `packages/web/src/server/websocket.ts` — when sending `tool:call` (around line 644-650), inject trace context:

```typescript
import { injectTraceContext } from "@bound/shared";

// In handleClientToolCallCreated:
const traceContext = injectTraceContext();

ws.send(JSON.stringify({
	type: "tool:call",
	call_id: event.call_id,
	thread_id: event.thread_id,
	tool_name: event.tool_name,
	arguments: event.arguments,
	...(traceContext ? { trace_context: JSON.stringify(traceContext) } : {}),
}));
```

**Server-side result schema** — update the Zod schema for `tool:result` (around line 76-82) to accept optional `trace_data`:

```typescript
const toolResultSchema = z.object({
	type: z.literal("tool:result"),
	call_id: z.string(),
	thread_id: z.string(),
	content: z.union([z.string(), z.array(contentBlockSchema)]),
	is_error: z.boolean().optional(),
	trace_data: z.string().optional(), // NEW: serialized spans from client
});
```

AC6.4 is satisfied automatically: `trace_context` is optional on the dispatch message, and `trace_data` is optional on the result. Clients that ignore both fields still send valid messages.

**Testing:**

Tests must verify:
- otel-tracing.AC6.1: When a span is active on the server, the `tool:call` message includes `trace_context` field
- otel-tracing.AC6.4: When a client sends `tool:result` without `trace_data`, it is accepted and processed normally (existing behavior preserved)

**Verification:**

Run: `bun run typecheck`
Expected: No type errors.

Run: `bun test packages/web`
Expected: All existing WebSocket tests pass.

**Commit:** `feat(web,client): extend WS tool protocol with trace_context and trace_data fields`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Server-side re-export of client trace_data spans

**Verifies:** otel-tracing.AC6.3

**Files:**
- Modify: `packages/web/src/server/websocket.ts` (handleToolResult function, around line 496-632)

**Implementation:**

In `handleToolResult`, after processing the tool result content, check for and re-export trace data:

```typescript
import type { SerializedSpan } from "@bound/shared";

// After existing result processing (around line 614, after acknowledgeClientToolCall):
if (msg.trace_data) {
	try {
		const spans = JSON.parse(msg.trace_data) as SerializedSpan[];
		reExportSpans(spans); // Same function from Phase 5
	} catch {
		// Invalid trace_data — silently ignore, don't break tool result flow
	}
}
```

The `reExportSpans` function from Phase 5 (exposed from telemetry.ts or a shared utility) handles pushing serialized spans to the local OTLP exporter.

**Testing:**

Tests must verify:
- otel-tracing.AC6.3: When `tool:result` includes valid `trace_data`, the spans are passed to the exporter
- Invalid `trace_data` (malformed JSON) does not break the tool result handling

**Verification:**

Run: `bun test packages/web`
Expected: All tests pass.

**Commit:** `feat(web): re-export client trace_data spans on tool result reception`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Client-side withClientToolTracing helper and boundless integration

**Verifies:** otel-tracing.AC6.2

**Files:**
- Create: `packages/client/src/tracing.ts`
- Modify: `packages/client/src/client.ts` (onToolCall handler invocation)
- Modify: `packages/less/src/session/attach.ts` (tool handler — no changes required since boundless uses BoundClient which now handles tracing internally)
- Test: `packages/client/src/__tests__/tracing.test.ts` (unit)

**Implementation:**

Create `packages/client/src/tracing.ts`:

```typescript
import { createScopedTraceCollector, extractTraceContext, type SerializedSpan } from "@bound/shared";
import { context } from "@opentelemetry/api";

export interface ClientToolTracingResult<T> {
	result: T;
	traceData: string | undefined;
}

/**
 * Wrap a client tool execution with trace context propagation.
 * Extracts parent context from the server's trace_context, creates child spans,
 * buffers them, and returns serialized spans alongside the tool result.
 *
 * If traceContext is null/undefined, executes the function without tracing overhead.
 */
export async function withClientToolTracing<T>(
	traceContextStr: string | undefined,
	fn: () => Promise<T>,
): Promise<ClientToolTracingResult<T>> {
	if (!traceContextStr) {
		const result = await fn();
		return { result, traceData: undefined };
	}

	const carrier = JSON.parse(traceContextStr) as Record<string, string>;
	const parentContext = extractTraceContext(carrier);
	const collector = createScopedTraceCollector();
	const tracer = collector.getTracer("bound.client-tool");

	let result: T;

	await context.with(parentContext, async () => {
		const span = tracer.startSpan("client-tool.execute");
		try {
			result = await fn();
			span.setStatus({ code: 1 }); // OK
		} catch (err) {
			span.setStatus({
				code: 2,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			span.end();
		}
	});

	const spans = await collector.flush();
	return {
		result: result!,
		traceData: spans.length > 0 ? JSON.stringify(spans) : undefined,
	};
}
```

**BoundClient integration** in `packages/client/src/client.ts` — modify the tool call handler invocation (in `handleWsMessage` around line 261) to wrap with tracing:

```typescript
import { withClientToolTracing } from "./tracing.js";

// In handleWsMessage where tool:call is processed:
const { result, traceData } = await withClientToolTracing(
	msg.trace_context,
	() => this.toolCallHandler!(msg),
);

// Include trace_data in the response:
this.sendWsMessage({
	type: "tool:result",
	call_id: msg.call_id,
	thread_id: msg.thread_id,
	content: result.content,
	is_error: result.is_error,
	...(traceData ? { trace_data: traceData } : {}),
});
```

**Boundless integration:** Since boundless uses `BoundClient` (via `client.onToolCall(handler)`), the tracing wrapper in BoundClient's `handleWsMessage` automatically applies to all tools registered through it — including `boundless_bash`. No changes to `packages/less/src/session/attach.ts` are needed; the integration is transparent through the client library.

**Testing:**

Tests must verify:
- otel-tracing.AC6.2: `withClientToolTracing` with valid trace context executes the function, collects spans, and returns non-empty `traceData`
- Without trace context, `withClientToolTracing` executes normally and returns `traceData: undefined`
- The collected spans have the correct parent trace ID from the injected context

**Verification:**

Run: `bun test packages/client/src/__tests__/tracing.test.ts`
Expected: All tests pass.

Run: `bun test --recursive`
Expected: Full test suite passes (no regressions across all packages).

**Commit:** `feat(client,less): add withClientToolTracing helper and wire into boundless`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
