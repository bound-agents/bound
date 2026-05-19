# OpenTelemetry Distributed Tracing Implementation Plan

**Goal:** OTEL SDK initialization and Pino logger mixin — TracerProvider registers when `OTEL_ENABLED` is set, Pino logs include trace correlation fields, zero overhead when disabled.

**Architecture:** `@opentelemetry/api` added to `packages/shared` (foundation layer) for unconditional span creation. SDK components (`BasicTracerProvider`, `BatchSpanProcessor`, `OTLPTraceExporter`) live in `packages/cli` for one-time startup initialization. Pino mixin reads active span context to inject `trace_id`/`span_id` into every log record.

**Tech Stack:** @opentelemetry/api, @opentelemetry/sdk-trace-base, @opentelemetry/exporter-trace-otlp-http, @opentelemetry/resources, @opentelemetry/semantic-conventions, Pino (existing)

**Scope:** 6 phases from original design (phases 1-6). This is phase 1.

**Codebase verified:** 2026-05-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### otel-tracing.AC1: Feature gate and initialization
- **otel-tracing.AC1.1 Success:** With OTEL_ENABLED=1 and Jaeger running, spans are exported to the configured endpoint
- **otel-tracing.AC1.2 Success:** OTEL_EXPORTER_OTLP_ENDPOINT overrides the default collector URL
- **otel-tracing.AC1.3 Success:** Without OTEL_ENABLED, startup is unaffected and no spans are exported
- **otel-tracing.AC1.4 Success:** shutdownTelemetry() flushes pending spans before process exit
- **otel-tracing.AC1.5 Failure:** Missing/unreachable collector does not crash the process (exports fail silently)

### otel-tracing.AC7: Pino log correlation
- **otel-tracing.AC7.1 Success:** Log records include trace_id and span_id when emitted within an active span
- **otel-tracing.AC7.2 Success:** Log records have no trace fields when no span is active
- **otel-tracing.AC7.3 Success:** Log records have no trace fields when OTEL is disabled

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add OpenTelemetry dependencies

**Files:**
- Modify: `packages/shared/package.json`
- Modify: `packages/cli/package.json`

**Implementation:**

Add `@opentelemetry/api` to `packages/shared/package.json` dependencies:

```json
{
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "js-tiktoken": "^1.0.21",
    "pino": "^10.3.1",
    "pino-pretty": "^13.1.3",
    "zod": "^4.0.0"
  }
}
```

Add SDK packages to `packages/cli/package.json` dependencies:

```json
{
  "dependencies": {
    "@bound/agent": "workspace:*",
    "@bound/core": "workspace:*",
    "@bound/llm": "workspace:*",
    "@bound/platforms": "workspace:*",
    "@bound/sandbox": "workspace:*",
    "@bound/shared": "workspace:*",
    "@bound/sync": "workspace:*",
    "@bound/web": "workspace:*",
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
    "@opentelemetry/resources": "^1.30.0",
    "@opentelemetry/sdk-trace-base": "^1.30.0",
    "@opentelemetry/semantic-conventions": "^1.28.0",
    "reflect-metadata": "^0.2.2"
  }
}
```

**Verification:**

Run: `bun install`
Expected: Installs without errors, lock file updated.

Run: `bun run typecheck`
Expected: No new type errors introduced.

**Commit:** `feat(shared,cli): add OpenTelemetry dependencies`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create telemetry.ts — initTelemetry and shutdownTelemetry

**Verifies:** otel-tracing.AC1.1, otel-tracing.AC1.2, otel-tracing.AC1.3, otel-tracing.AC1.4, otel-tracing.AC1.5

**Files:**
- Create: `packages/cli/src/commands/start/telemetry.ts`
- Test: `packages/cli/src/__tests__/telemetry.test.ts` (unit)

**Implementation:**

Create `packages/cli/src/commands/start/telemetry.ts`:

```typescript
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let provider: BasicTracerProvider | null = null;

/**
 * Initialize OpenTelemetry tracing when OTEL_ENABLED is set.
 * Registers a BasicTracerProvider with BatchSpanProcessor exporting to OTLP HTTP.
 * When OTEL_ENABLED is not set, this is a no-op — the @opentelemetry/api returns
 * no-op spans by design, guaranteeing zero overhead.
 */
export function initTelemetry(serviceName: string): void {
	if (!process.env.OTEL_ENABLED) return;

	const endpoint =
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

	const resource = Resource.default().merge(
		new Resource({
			[ATTR_SERVICE_NAME]: serviceName,
		}),
	);

	const exporter = new OTLPTraceExporter({
		url: `${endpoint}/v1/traces`,
	});

	provider = new BasicTracerProvider({ resource });
	provider.addSpanProcessor(new BatchSpanProcessor(exporter));
	provider.register();
}

/**
 * Flush pending spans and shut down the TracerProvider.
 * Returns immediately if telemetry was never initialized.
 */
export async function shutdownTelemetry(): Promise<void> {
	if (!provider) return;
	await provider.forceFlush();
	await provider.shutdown();
	provider = null;
}
```

**Testing:**

Tests must verify each AC listed above:
- otel-tracing.AC1.1: With OTEL_ENABLED=1, calling initTelemetry registers a provider and trace.getTracer() returns a recording tracer (span.isRecording() is true)
- otel-tracing.AC1.2: Setting OTEL_EXPORTER_OTLP_ENDPOINT changes the exporter URL (verify via InMemorySpanExporter or spy on OTLPTraceExporter constructor)
- otel-tracing.AC1.3: Without OTEL_ENABLED, initTelemetry is a no-op and trace.getTracer() returns a non-recording no-op tracer
- otel-tracing.AC1.4: shutdownTelemetry flushes and shuts down the provider (verify spans are exported)
- otel-tracing.AC1.5: When the collector is unreachable, initTelemetry succeeds and span creation does not throw

Use `InMemorySpanExporter` + `SimpleSpanProcessor` to verify spans are recorded in tests without needing a real collector. Test file at `packages/cli/src/__tests__/telemetry.test.ts`.

**Verification:**

Run: `bun test packages/cli/src/__tests__/telemetry.test.ts`
Expected: All tests pass.

**Commit:** `feat(cli): add initTelemetry and shutdownTelemetry`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add Pino mixin for trace context injection

**Verifies:** otel-tracing.AC7.1, otel-tracing.AC7.2, otel-tracing.AC7.3

**Files:**
- Modify: `packages/shared/src/logger.ts` (line 56, `getRootLogger` function)
- Test: `packages/shared/src/__tests__/logger-trace-mixin.test.ts` (unit)

**Implementation:**

Modify `packages/shared/src/logger.ts`. Add import at the top:

```typescript
import { trace } from "@opentelemetry/api";
```

Replace line 56 (`rootLogger = pino({ level }, pino.multistream(streams));`) with:

```typescript
rootLogger = pino(
	{
		level,
		mixin() {
			const span = trace.getActiveSpan();
			if (!span) return {};
			const ctx = span.spanContext();
			return {
				trace_id: ctx.traceId,
				span_id: ctx.spanId,
				trace_flags: ctx.traceFlags,
			};
		},
	},
	pino.multistream(streams),
);
```

Also add the mixin to the silent-mode logger (line 29) so behavior is consistent regardless of code path:

```typescript
if (level === "silent") {
	rootLogger = pino({
		level,
		mixin() {
			const span = trace.getActiveSpan();
			if (!span) return {};
			const ctx = span.spanContext();
			return {
				trace_id: ctx.traceId,
				span_id: ctx.spanId,
				trace_flags: ctx.traceFlags,
			};
		},
	});
	return rootLogger;
}
```

**Testing:**

Tests must verify:
- otel-tracing.AC7.1: When a span is active (provider registered, span started via `tracer.startActiveSpan`), log output JSON includes `trace_id` and `span_id` fields matching the span's context
- otel-tracing.AC7.2: When no span is active (provider registered but no span started), log output JSON does NOT include `trace_id` or `span_id` fields
- otel-tracing.AC7.3: When OTEL is disabled (no provider registered), log output JSON does NOT include `trace_id` or `span_id` fields

Use `resetLogger()` between tests to get fresh root logger instances. Use `InMemorySpanExporter` + `BasicTracerProvider` to control span lifecycle in tests. Parse log file JSON to verify field presence/absence.

**Verification:**

Run: `bun test packages/shared/src/__tests__/logger-trace-mixin.test.ts`
Expected: All tests pass.

Run: `bun test packages/shared`
Expected: Existing logger tests still pass (no regression).

**Commit:** `feat(shared): add Pino mixin for OTEL trace context injection`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire initTelemetry into startup and shutdownTelemetry into graceful shutdown

**Verifies:** otel-tracing.AC1.1, otel-tracing.AC1.4

**Files:**
- Modify: `packages/cli/src/commands/start/index.ts` (add import and call before line 24)
- Modify: `packages/cli/src/commands/start/scheduler.ts` (add shutdown call before line 290)

**Implementation:**

In `packages/cli/src/commands/start/index.ts`, add import:

```typescript
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";
```

Add telemetry initialization as the very first line of `runStart()`, before `initBootstrap`:

```typescript
export async function runStart(args: StartArgs): Promise<void> {
	// Phase 0: Telemetry (must be first so all subsequent operations are traced)
	initTelemetry("bound");

	// Phase 1: Bootstrap (config, DB, keypair, users, host, crash recovery)
	const { appContext, keypair, configDir } = await initBootstrap(args);
	// ...
```

In `packages/cli/src/commands/start/scheduler.ts`, add import:

```typescript
import { shutdownTelemetry } from "./telemetry.js";
```

In the `shutdown` function, add telemetry shutdown after `syncServer.stop()` and before the `resolve()` call (the final statement in the shutdown handler):

```typescript
if (handles.webServer) await handles.webServer.stop();
if (handles.syncServer) await handles.syncServer.stop();
await shutdownTelemetry();
resolve();
```

**Verification:**

Run: `bun run typecheck`
Expected: No type errors.

Run: `bun test --recursive`
Expected: All existing tests pass (no regression from telemetry init running without OTEL_ENABLED).

**Commit:** `feat(cli): wire telemetry init/shutdown into start command lifecycle`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->
