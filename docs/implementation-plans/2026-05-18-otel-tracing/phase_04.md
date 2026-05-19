# OpenTelemetry Distributed Tracing — Phase 4: Root Spans for All Entry Points

**Goal:** Every path into the agent loop produces a root span, giving end-to-end visibility regardless of how the loop was triggered.

**Architecture:** Three unique agent loop invocation points exist: (1) Scheduler — serves cron, deferred, event (webhook/platform), and heartbeat tasks; (2) Web server — user messages via ThreadExecutor; (3) Relay processor — delegated inference from remote hosts. Webhooks and platform events flow through the scheduler, so `task.type` and `task.trigger_spec` attributes distinguish them. Root spans carry contextual attributes identifying the trigger.

**Tech Stack:** @opentelemetry/api (already in packages/shared from Phase 1)

**Scope:** 6 phases from original design (phases 1-6). This is phase 4.

**Codebase verified:** 2026-05-18

**Design divergence:** The design plan specifies 4 separate root span types (scheduler, web, webhook, connector). Investigation reveals webhooks and connector events both flow through the scheduler entry point via `task.type = "event"`. We use a single `scheduler.execute-task` root span with `task.type` attribute to distinguish trigger types, plus separate root spans for web messages and relay processing.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### otel-tracing.AC4: Entry point root spans
- **otel-tracing.AC4.1 Success:** Scheduler-triggered loops produce traces rooted at scheduler.execute-task
- **otel-tracing.AC4.2 Success:** Web UI messages produce traces rooted at web.handle-message
- **otel-tracing.AC4.3 Success:** Webhook invocations produce traces rooted at scheduler.execute-task (with task.type="event" and task.trigger_spec matching webhook event)
- **otel-tracing.AC4.4 Success:** Platform connector events produce traces rooted at scheduler.execute-task (with task.type="event" and task.trigger_spec matching connector event)

---

<!-- START_TASK_1 -->
### Task 1: Add scheduler.execute-task root span

**Verifies:** otel-tracing.AC4.1, otel-tracing.AC4.3, otel-tracing.AC4.4

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (around line ~1100 where `agentLoop.run()` is called)
- Test: `packages/agent/src/__tests__/scheduler-spans.test.ts` (unit)

**Implementation:**

Add import at the top of `scheduler.ts`:

```typescript
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.scheduler");
```

Wrap the agent loop invocation (around line 1100) with a root span:

```typescript
const rootSpan = tracer.startSpan("scheduler.execute-task", {
	attributes: {
		"task.id": task.id,
		"task.name": task.name ?? "",
		"task.type": task.type,
		"task.trigger_spec": task.trigger_spec ?? "",
		"thread.id": loopConfig.threadId,
	},
});

try {
	const result = await context.with(
		trace.setSpan(context.active(), rootSpan),
		async () => {
			const agentLoop = this.agentLoopFactory(loopConfig);
			return agentLoop.run();
		},
	);
	rootSpan.setStatus({ code: SpanStatusCode.OK });
	return result;
} catch (err) {
	rootSpan.setStatus({
		code: SpanStatusCode.ERROR,
		message: err instanceof Error ? err.message : String(err),
	});
	throw err;
} finally {
	rootSpan.end();
}
```

The `context.with(trace.setSpan(...))` call sets the root span as the active span in context, so all child spans (from Phase 2/3) nest correctly underneath.

**Testing:**

Tests must verify:
- otel-tracing.AC4.1: A scheduler-triggered task (type "cron") produces a root span named `scheduler.execute-task` with `task.type` = `"cron"`
- otel-tracing.AC4.3: An event task from a webhook produces `scheduler.execute-task` with `task.type` = `"event"` and appropriate `task.trigger_spec`
- otel-tracing.AC4.4: An event task from a platform connector produces `scheduler.execute-task` with `task.type` = `"event"`

Use `InMemorySpanExporter`. Mock the agentLoopFactory to return a minimal mock that resolves immediately. Create test tasks with different `type` values.

**Verification:**

Run: `bun test packages/agent/src/__tests__/scheduler-spans.test.ts`
Expected: All tests pass.

**Commit:** `feat(agent): add scheduler.execute-task root span for all scheduled entries`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add web.handle-message root span

**Verifies:** otel-tracing.AC4.2

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (around line ~559 where `runLocalAgentLoop` is called, inside the `threadExecutor.execute` callback)
- Test: `packages/cli/src/__tests__/web-message-spans.test.ts` (unit)

**Implementation:**

Add import at the top of `server.ts`:

```typescript
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.web");
```

Wrap the `runLocalAgentLoop` call inside the ThreadExecutor callback with a root span:

```typescript
const rootSpan = tracer.startSpan("web.handle-message", {
	attributes: {
		"thread.id": thread_id,
		"user.id": userId,
		"message.id": messageId,
		"platform": platform ?? "web",
	},
});

try {
	const { agentResult: result } = await context.with(
		trace.setSpan(context.active(), rootSpan),
		() =>
			runLocalAgentLoop({
				eventBus,
				threadId: thread_id,
				userId,
				modelId: activeModelId,
				activeLoopAbortControllers,
				agentLoopFactory,
				shouldYield,
				platform,
				clientTools,
				connectionId,
				systemPromptAddition,
				platformTools,
			}),
	);
	rootSpan.setStatus({ code: SpanStatusCode.OK });
} catch (err) {
	rootSpan.setStatus({
		code: SpanStatusCode.ERROR,
		message: err instanceof Error ? err.message : String(err),
	});
	throw err;
} finally {
	rootSpan.end();
}
```

**Testing:**

Tests must verify:
- otel-tracing.AC4.2: A user message via web produces a root span named `web.handle-message` with `thread.id`, `user.id`, and `platform` attributes

Use `InMemorySpanExporter`. Mock `runLocalAgentLoop` to resolve immediately. Simulate the flow that triggers `handleThread`.

**Verification:**

Run: `bun test packages/cli/src/__tests__/web-message-spans.test.ts`
Expected: All tests pass.

**Commit:** `feat(cli): add web.handle-message root span for user message handling`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add relay.execute-process root span

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (around line ~1585 where `agentLoop.run()` is called in `runDelegatedLoop`)
- Test: `packages/agent/src/__tests__/relay-processor-spans.test.ts` (unit)

**Implementation:**

Add import at the top of `relay-processor.ts`:

```typescript
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("bound.relay");
```

Wrap the `agentLoop.run()` call in `runDelegatedLoop` with a root span:

```typescript
const rootSpan = tracer.startSpan("relay.execute-process", {
	attributes: {
		"thread.id": payload.thread_id,
		"user.id": payload.user_id ?? "",
		"source.site_id": entry.source_site_id,
		"platform": payload.platform ?? "",
	},
});

try {
	const result = await context.with(
		trace.setSpan(context.active(), rootSpan),
		async () => {
			const agentLoop = this.agentLoopFactory
				? this.agentLoopFactory(loopConfig)
				: new AgentLoop(delegatedCtx, {}, this.modelRouter!, loopConfig);
			return agentLoop.run();
		},
	);
	rootSpan.setStatus({ code: SpanStatusCode.OK });
	return result;
} catch (err) {
	rootSpan.setStatus({
		code: SpanStatusCode.ERROR,
		message: err instanceof Error ? err.message : String(err),
	});
	throw err;
} finally {
	rootSpan.end();
}
```

**Testing:**

Tests must verify:
- A relay process delegation produces a root span named `relay.execute-process` with `thread.id`, `source.site_id` attributes
- Error during delegated loop sets span status to ERROR

Use `InMemorySpanExporter`. Mock agentLoopFactory. Create a minimal ProcessPayload and RelayInboxEntry.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-processor-spans.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing tests pass.

**Commit:** `feat(agent): add relay.execute-process root span for delegated inference`
<!-- END_TASK_3 -->
