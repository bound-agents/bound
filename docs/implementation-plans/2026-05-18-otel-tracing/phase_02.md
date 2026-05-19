# OpenTelemetry Distributed Tracing — Phase 2: Agent Loop and Context Assembly Spans

**Goal:** Per-turn and per-stage timing visible in Jaeger when OTEL is enabled. Replace existing `Date.now()` timing variables with span-derived durations.

**Architecture:** Agent loop state transitions become child spans under a per-turn root span (`agent-loop.turn`). Context assembly stages become child spans under `agent-loop.assemble-context`. Span attributes capture thread/task/model metadata and token counts. Existing timing variables (`turnStartTime`, `llmDurationMs`, `toolDurationMs`) are removed; their logged values are derivable from span durations.

**Tech Stack:** @opentelemetry/api (already in packages/shared from Phase 1)

**Scope:** 6 phases from original design (phases 1-6). This is phase 2.

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### otel-tracing.AC2: Agent loop and context assembly spans
- **otel-tracing.AC2.1 Success:** Each agent turn produces a root span with child spans for each state transition
- **otel-tracing.AC2.2 Success:** Context assembly produces per-stage child spans (stages 1-8 + 5.5)
- **otel-tracing.AC2.3 Success:** Warm vs cold cache path is recorded as a span attribute on assemble-context
- **otel-tracing.AC2.4 Success:** Token counts and model ID are recorded as span attributes after LLM response
- **otel-tracing.AC2.5 Success:** Existing Date.now() timing variables are removed without affecting other functionality

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Instrument agent loop with per-turn and per-state spans

**Verifies:** otel-tracing.AC2.1, otel-tracing.AC2.3, otel-tracing.AC2.4, otel-tracing.AC2.5

**Files:**
- Modify: `packages/agent/src/agent-loop.ts`
- Test: `packages/agent/src/__tests__/agent-loop-spans.test.ts` (unit)

**Implementation:**

Add import at the top of `agent-loop.ts`:

```typescript
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.agent-loop");
```

**Per-turn root span:** Wrap the per-turn body (starting at line ~811 inside the `while (continueLoop)` loop) in a span using `context.with()` to establish it as the active parent for all child spans:

```typescript
const turnSpan = tracer.startSpan("agent-loop.turn", {
	attributes: {
		"thread.id": this.config.threadId,
		"task.id": this.config.taskId ?? "",
	},
});

// Use context.with() so all code within sees turnSpan as the active parent
await context.with(trace.setSpan(context.active(), turnSpan), async () => {
	// ... entire turn body ...
});

turnSpan.end();
```

End the turn span at the bottom of the `context.with()` callback. Set span status to ERROR on exceptions.

**Important: span nesting requires `context.with()`**. OTEL only establishes parent-child relationships when the parent span is active in context. Every child span must be created within the `context.with()` of its parent. The pattern for child spans:

```typescript
// Create child span — automatically nests under turnSpan because turnSpan is active
const childSpan = tracer.startSpan("agent-loop.assemble-context");
await context.with(trace.setSpan(context.active(), childSpan), async () => {
	// Code here — any spans created inside will be children of childSpan
	await assembleContext(params); // stage spans inside will nest correctly
});
childSpan.end();
```

**State transition child spans:** For each major state, create a child span within `context.with()` of the turn span. The key states to instrument:

- `agent-loop.hydrate-fs` — wrapping the filesystem hydration section
- `agent-loop.assemble-context` — wrapping both warm and cold paths (with attribute `context.cache_path` = `"warm"` or `"cold"`). **Must use `context.with()`** so that context assembly stage spans (Phase 2 Task 2) automatically nest as children.
- `agent-loop.llm-call` — wrapping the LLM chat invocation. **Must use `context.with()`** so driver spans (Phase 3) nest correctly.
- `agent-loop.tool-execute` — wrapping the entire tool dispatch loop. **Must use `context.with()`** so per-tool spans (Phase 3) nest correctly.
- `agent-loop.response-persist` — wrapping message persistence
- `agent-loop.fs-persist` — wrapping file system persistence

**Span attributes after LLM response** (near line ~1219 where `recordTurn()` is called):

```typescript
turnSpan.setAttributes({
	"model.id": resolvedModelForDebug,
	"model.kind": lastModelResolution?.kind ?? "unknown",
	"llm.input_tokens": usage.inputTokens,
	"llm.output_tokens": usage.outputTokens,
	"llm.cache_read_tokens": usage.cacheReadTokens ?? 0,
	"llm.cache_write_tokens": usage.cacheWriteTokens ?? 0,
});
```

**Remove timing variables:**
- Remove `turnStartTime` (line ~811) — replaced by `turnSpan` start time
- Remove `llmDurationMs` computation (line ~1137) — derivable from `agent-loop.llm-call` span duration
- Remove `toolStartTime` and `toolDurationMs` (lines ~1363, ~1530) — replaced by tool spans (Phase 3)
- Keep `loopStartTime` / `totalDurationMs` for the completion log since it spans multiple turns; alternatively derive from a wrapping span

Update the existing log statements (lines ~1139, ~1531, ~1815) to remove the now-redundant `*DurationMs` fields. The log messages themselves can remain (they serve log-file debugging without Jaeger), but the timing comes from spans now.

**Testing:**

Tests must verify:
- otel-tracing.AC2.1: An agent turn (mocked LLM returning text) produces spans: `agent-loop.turn` root with children `agent-loop.hydrate-fs`, `agent-loop.assemble-context`, `agent-loop.llm-call`, `agent-loop.response-persist`
- otel-tracing.AC2.3: The `agent-loop.assemble-context` span has attribute `context.cache_path` = `"cold"` on first turn and `"warm"` on second turn (when cache is hit)
- otel-tracing.AC2.4: After LLM response, `turnSpan` has attributes `model.id`, `llm.input_tokens`, `llm.output_tokens`
- otel-tracing.AC2.5: The `turnStartTime`, `llmDurationMs`, `toolDurationMs` variables no longer exist; verify by checking that the agent loop still completes a turn and logs are still emitted

Use `InMemorySpanExporter` + `SimpleSpanProcessor` + `BasicTracerProvider` registered before test. Use the existing `MockLLMBackend` pattern for LLM responses. Create a minimal agent loop config with real temp DB.

**Verification:**

Run: `bun test packages/agent/src/__tests__/agent-loop-spans.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing agent tests pass (no regressions from timing variable removal).

**Commit:** `feat(agent): instrument agent loop with per-turn and per-state OTEL spans`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Instrument context assembly with per-stage spans

**Verifies:** otel-tracing.AC2.2

**Files:**
- Modify: `packages/agent/src/context-assembly.ts`
- Test: `packages/agent/src/__tests__/context-assembly-spans.test.ts` (unit)

**Implementation:**

Add import at the top of `context-assembly.ts`:

```typescript
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.context-assembly");
```

Wrap each stage in a span. The stages are linearly arranged in `assembleContext()`. Since `assembleContext()` is called within a `context.with()` block (from Task 1's `agent-loop.assemble-context` span), all spans created via `tracer.startSpan()` here automatically become children of the assemble-context span — no additional `context.with()` needed for leaf spans (they don't have children of their own):

```typescript
// Stage 1
const stage1Span = tracer.startSpan("context.stage-1-message-retrieval");
// ... existing stage 1 code (lines 725-754) ...
stage1Span.end();

// Stage 1.5
const stage1_5Span = tracer.startSpan("context.stage-1.5-retroactive-result-truncation");
// ... existing code (lines 756-766) ...
stage1_5Span.end();

// Stage 1.7
const stage1_7Span = tracer.startSpan("context.stage-1.7-history-compaction");
// ... existing code (lines 768-845) ...
stage1_7Span.end();

// Stage 2
const stage2Span = tracer.startSpan("context.stage-2-purge-substitution");
// ... existing code (lines 847-871) ...
stage2Span.end();

// Stage 2.5
const stage2_5Span = tracer.startSpan("context.stage-2.5-role-filtering");
// ... existing code (lines 960-969) ...
stage2_5Span.end();

// Stage 3
const stage3Span = tracer.startSpan("context.stage-3-tool-pair-sanitization");
// ... existing code (lines 971-1289) ...
stage3Span.end();

// Stage 5
const stage5Span = tracer.startSpan("context.stage-5-annotation");
// ... existing code (lines 1294-1424) ...
stage5Span.end();

// Stage 5b
const stage5bSpan = tracer.startSpan("context.stage-5b-content-substitution");
// ... existing code (lines 1426-1431) ...
stage5bSpan.end();

// Stage 5.5
const stage5_5Span = tracer.startSpan("context.stage-5.5-volatile-enrichment");
// ... existing volatile enrichment code ...
stage5_5Span.end();

// Stage 6
const stage6Span = tracer.startSpan("context.stage-6-assembly");
// ... existing code (lines 1433-1760) ...
stage6Span.end();

// Stage 7
const stage7Span = tracer.startSpan("context.stage-7-budget-validation");
// ... existing code (lines 1765-2081) ...
stage7Span.setAttribute("context.total_tokens", totalTokens);
stage7Span.setAttribute("context.headroom", headroom);
stage7Span.setAttribute("context.truncated_messages", truncatedCount);
stage7Span.end();

// Stage 8
const stage8Span = tracer.startSpan("context.stage-8-metric-recording");
// ... existing metric recording ...
stage8Span.end();
```

Add useful attributes to specific stages:
- Stage 1: `message_count` attribute with retrieved message count
- Stage 3: `orphan_tool_calls_fixed` count if any synthetic results were injected
- Stage 7: `total_tokens`, `headroom`, `truncated_messages`

**Testing:**

Tests must verify:
- otel-tracing.AC2.2: A full context assembly produces spans for each stage: `context.stage-1-message-retrieval`, `context.stage-2-purge-substitution`, `context.stage-3-tool-pair-sanitization`, `context.stage-5-annotation`, `context.stage-5.5-volatile-enrichment`, `context.stage-6-assembly`, `context.stage-7-budget-validation`, `context.stage-8-metric-recording`
- Verify that stage spans are children of the calling context (when called from within an active `agent-loop.assemble-context` span)
- Verify Stage 7 span has `context.total_tokens` attribute set

Use `InMemorySpanExporter` to capture finished spans. Call `assembleContext()` directly with a minimal params object (real temp DB with at least one message in a thread).

**Verification:**

Run: `bun test packages/agent/src/__tests__/context-assembly-spans.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing context assembly tests pass (60+ tests, no regressions).

**Commit:** `feat(agent): instrument context assembly pipeline with per-stage OTEL spans`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
