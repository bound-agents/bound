# OpenTelemetry Distributed Tracing — Phase 3: LLM Driver and Tool Dispatch Spans

**Goal:** LLM inference and tool execution visible as child spans with time-to-first-token events and meaningful attributes.

**Architecture:** LLM driver spans wrap the `chat()` async generator at the agent-loop consumption site (not inside drivers themselves, since drivers yield via generators and TTFT is measured at the consumer). Tool dispatch spans wrap each `tool.execute()` call with `tool.name` and `tool.kind` attributes. Error status is set on tool failures.

**Tech Stack:** @opentelemetry/api (already in packages/shared from Phase 1)

**Scope:** 6 phases from original design (phases 1-6). This is phase 3.

**Codebase verified:** 2026-05-18

**Design divergence:** The design plan mentions 3 separate driver files (anthropic, bedrock, openai). The actual codebase uses 2 drivers (`bedrock-driver.ts`, `openai-compatible-driver.ts`) plus a shared `ai-sdk-bridge.ts`. LLM spans are instrumented at the agent-loop level where the stream is consumed, providing uniform coverage regardless of backend.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### otel-tracing.AC3: LLM driver and tool spans
- **otel-tracing.AC3.1 Success:** Each LLM chat() call produces a child span under agent-loop.llm-call
- **otel-tracing.AC3.2 Success:** Time-to-first-token and completion are recorded as span events
- **otel-tracing.AC3.3 Success:** Each tool execution produces a child span with tool.name and tool.kind attributes
- **otel-tracing.AC3.4 Failure:** Tool execution errors set span status to ERROR with error message

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Instrument LLM chat stream with TTFT and completion events

**Verifies:** otel-tracing.AC3.1, otel-tracing.AC3.2

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (LLM call section, lines ~952-1004)
- Test: `packages/agent/src/__tests__/llm-driver-spans.test.ts` (unit)

**Implementation:**

The LLM call span wraps the stream consumption loop in `agent-loop.ts`. The tracer is already imported from Phase 2. Add a child span for the LLM driver call:

```typescript
// Inside the existing agent-loop.llm-call span from Phase 2,
// create a more specific child span for the actual driver invocation:
const driverSpan = tracer.startSpan("llm-driver.chat", {
	attributes: {
		"llm.model": resolvedModelForDebug,
		"llm.provider": resolution.kind === "local" ? "local" : "remote",
	},
});

let ttftRecorded = false;

const chatStream = resolution.backend.chat({ /* existing params */ });

try {
	for await (const chunk of this.withSilenceTimeout(chatStream, effectiveSilenceTimeout, () => this.config.onActivity?.())) {
		if (this.aborted) break;
		if (this.config.shouldYield?.()) {
			this.yielded = true;
			this.aborted = true;
			break;
		}
		this.config.onActivity?.();

		if (chunk.type === "heartbeat") continue;

		// Record TTFT on first non-heartbeat chunk
		if (!ttftRecorded) {
			driverSpan.addEvent("time-to-first-token");
			ttftRecorded = true;
		}

		chunks.push(chunk);
	}

	// Record completion event with token counts from the done chunk
	const doneChunk = chunks.find((c) => c.type === "done");
	if (doneChunk && doneChunk.type === "done") {
		driverSpan.addEvent("completion", {
			"llm.input_tokens": doneChunk.usage.input_tokens,
			"llm.output_tokens": doneChunk.usage.output_tokens,
		});
	}
	driverSpan.setStatus({ code: SpanStatusCode.OK });
} catch (err) {
	driverSpan.setStatus({
		code: SpanStatusCode.ERROR,
		message: err instanceof Error ? err.message : String(err),
	});
	throw err;
} finally {
	driverSpan.end();
}
```

**Testing:**

Tests must verify:
- otel-tracing.AC3.1: A mocked LLM stream (yielding heartbeat → text → done) produces a `llm-driver.chat` span as child of `agent-loop.llm-call`
- otel-tracing.AC3.2: The `llm-driver.chat` span has events named `time-to-first-token` and `completion`; TTFT fires on first non-heartbeat chunk, completion carries token count attributes

Use `InMemorySpanExporter` + `BasicTracerProvider`. Use `MockLLMBackend` that yields `heartbeat`, then `text` chunk, then `done` chunk. Verify span events via `span.events` array on the finished span from the exporter.

**Verification:**

Run: `bun test packages/agent/src/__tests__/llm-driver-spans.test.ts`
Expected: All tests pass.

**Commit:** `feat(agent): instrument LLM chat stream with TTFT and completion span events`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Instrument tool dispatch with per-tool spans

**Verifies:** otel-tracing.AC3.3, otel-tracing.AC3.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (executeToolCall method, lines ~1910-2029)
- Test: `packages/agent/src/__tests__/tool-dispatch-spans.test.ts` (unit)

**Implementation:**

In the `executeToolCall()` method, wrap each execution path in a span. The tool name and kind are available from the registry lookup:

```typescript
private async executeToolCall(
	toolCall: ParsedToolCall,
): Promise<{ content: string; exitCode: number } | RelayToolCallRequest | ClientToolCallRequest> {
	if (this.config.toolRegistry) {
		const tool = this.config.toolRegistry.get(toolCall.name);
		if (!tool) {
			return { content: `Error: unknown tool "${toolCall.name}"`, exitCode: 1 };
		}

		// Client tools are deferred — no execution span here
		if (tool.kind === "client") {
			return {
				clientToolCall: true,
				toolName: toolCall.name,
				callId: toolCall.id,
				arguments: toolCall.input,
			} satisfies ClientToolCallRequest;
		}

		// Create span for all other tool kinds
		const toolSpan = tracer.startSpan("tool.execute", {
			attributes: {
				"tool.name": toolCall.name,
				"tool.kind": tool.kind,
				"tool.call_id": toolCall.id,
			},
		});

		try {
			let result: { content: string; exitCode: number };

			switch (tool.kind) {
				case "platform": {
					// ... existing platform execution ...
					const rawResult = await (tool.execute as any)(toolCall.input);
					// ... existing result handling to get content/exitCode ...
					result = { content: /* processed */, exitCode: /* computed */ };
					break;
				}
				case "sandbox": {
					// ... existing sandbox execution ...
					const rawResult = await this.sandbox.exec(command);
					result = { content: rawResult.stdout, exitCode: rawResult.exitCode };
					break;
				}
				default: {
					// builtin tools
					const rawResult = await tool.execute!(toolCall.input);
					// ... existing result handling ...
					result = { content: /* processed */, exitCode: /* computed */ };
					break;
				}
			}

			if (result.exitCode !== 0) {
				toolSpan.setStatus({
					code: SpanStatusCode.ERROR,
					message: result.content.slice(0, 256),
				});
			} else {
				toolSpan.setStatus({ code: SpanStatusCode.OK });
			}

			return result;
		} catch (err) {
			toolSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			return {
				content: `Error: ${err instanceof Error ? err.message : String(err)}`,
				exitCode: 1,
			};
		} finally {
			toolSpan.end();
		}
	}

	// Legacy paths — also wrap with spans following same pattern
	// ...
}
```

**Testing:**

Tests must verify:
- otel-tracing.AC3.3: Executing a builtin tool (e.g., `query`) produces a `tool.execute` span with `tool.name` = `"query"` and `tool.kind` = `"builtin"` attributes
- otel-tracing.AC3.4: When a tool returns with `exitCode: 1` (error), the span status is set to ERROR with the error content as the message

Use `InMemorySpanExporter`. Create a minimal tool registry with a mock tool that succeeds (returns string) and one that fails (returns "Error: ..."). Call `executeToolCall()` and verify span attributes and status.

**Verification:**

Run: `bun test packages/agent/src/__tests__/tool-dispatch-spans.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent`
Expected: All existing agent tests pass (no regressions).

**Commit:** `feat(agent): instrument tool dispatch with per-tool OTEL spans`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
