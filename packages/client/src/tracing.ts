import { type SerializedSpan, extractTraceContext, serializeReadableSpan } from "@bound/shared";
import type { Context, Span } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface ClientToolTracingResult<T> {
	result: T;
	/** Serialized SerializedSpan[] from this call's flush, JSON-stringified. */
	traceData: string | undefined;
}

export interface WrapToolCallOptions {
	/** Tool name for the `tool.name` attribute (e.g. "boundless_bash"). */
	toolName?: string;
}

/**
 * A long-lived client-side tracing session, scoped to one WebSocket connection.
 *
 * The session holds a single `BasicTracerProvider` for the connection's lifetime
 * and groups tool calls under a `boundless.session` span keyed to the server-injected
 * `traceparent`. When the traceparent changes (a new agent turn on the server side),
 * the previous session span is closed and a new one is opened — so all parallel/serial
 * client tool calls dispatched under one server-side parent share one session parent.
 *
 * Each `client-tool.execute` span:
 *   - parents to the active `boundless.session` span (groups siblings on the client trace);
 *   - carries a `Link` to the server-side `SpanContext` (cross-trace nav in Jaeger).
 *
 * This replaces the per-call provider churn of the old `withClientToolTracing` and
 * stops `client-tool.execute` from dangling under `web.handle-message` on the server trace.
 */
export interface ClientTracingSession {
	/**
	 * Wrap a single tool call with tracing. Returns the tool's result plus any
	 * spans that completed during this call (serialized for shipping back to the server).
	 *
	 * If `traceContextStr` is missing, malformed, or has no `traceparent`, executes
	 * `fn` without any tracing overhead and returns `traceData: undefined`. Tracing
	 * setup failures must never block tool execution.
	 */
	wrapToolCall<T>(
		traceContextStr: string | undefined,
		fn: () => Promise<T>,
		options?: WrapToolCallOptions,
	): Promise<ClientToolTracingResult<T>>;

	/**
	 * End the session: close any active `boundless.session` span, drain the exporter,
	 * shut down the provider (fire-and-forget), and return the final batch of serialized
	 * spans (for shipping in a trailing message before WS close).
	 *
	 * Synchronous — `SimpleSpanProcessor` exports each span on `span.end()`, so the
	 * exporter array is populated by the time this returns. Idempotent — subsequent
	 * calls return `[]`.
	 */
	end(): SerializedSpan[];
}

interface ActiveBatch {
	/** The `traceparent` header value this batch is bound to. */
	traceparent: string;
	span: Span;
	context: Context;
}

export function createClientTracingSession(): ClientTracingSession {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	const tracer = provider.getTracer("bound.client-tool");

	let activeBatch: ActiveBatch | null = null;
	let sessionEnded = false;

	const drainFinished = (): SerializedSpan[] => {
		const finished = exporter.getFinishedSpans();
		exporter.reset();
		return finished.map(serializeReadableSpan);
	};

	const closeActiveBatch = (): void => {
		if (activeBatch) {
			activeBatch.span.end();
			activeBatch = null;
		}
	};

	return {
		async wrapToolCall<T>(
			traceContextStr: string | undefined,
			fn: () => Promise<T>,
			options?: WrapToolCallOptions,
		): Promise<ClientToolTracingResult<T>> {
			if (sessionEnded || !traceContextStr) {
				const result = await fn();
				return { result, traceData: undefined };
			}

			let carrier: Record<string, string>;
			try {
				carrier = JSON.parse(traceContextStr) as Record<string, string>;
			} catch {
				const result = await fn();
				return { result, traceData: undefined };
			}

			const traceparent = carrier.traceparent;
			if (!traceparent) {
				const result = await fn();
				return { result, traceData: undefined };
			}

			// Roll the batch when the server-injected traceparent changes.
			// One agent turn => one `boundless.session` span containing all client tool children.
			if (activeBatch && activeBatch.traceparent !== traceparent) {
				closeActiveBatch();
			}

			const linkedCtx = extractTraceContext(carrier);
			const linkedSpanContext = trace.getSpan(linkedCtx)?.spanContext();

			if (!activeBatch) {
				const batchSpan = tracer.startSpan("boundless.session", {
					kind: SpanKind.INTERNAL,
					links: linkedSpanContext ? [{ context: linkedSpanContext }] : [],
				});
				activeBatch = {
					traceparent,
					span: batchSpan,
					context: trace.setSpan(context.active(), batchSpan),
				};
			}

			const span = tracer.startSpan(
				"client-tool.execute",
				{
					kind: SpanKind.INTERNAL,
					attributes: options?.toolName ? { "tool.name": options.toolName } : {},
					links: linkedSpanContext ? [{ context: linkedSpanContext }] : [],
				},
				activeBatch.context,
			);

			let result: T;
			try {
				result = await context.with(trace.setSpan(activeBatch.context, span), fn);
				span.setStatus({ code: SpanStatusCode.OK });
			} catch (err) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
				span.end();
				throw err;
			}
			span.end();

			const serialized = drainFinished();
			return {
				result,
				traceData: serialized.length > 0 ? JSON.stringify(serialized) : undefined,
			};
		},

		end(): SerializedSpan[] {
			if (sessionEnded) return [];
			sessionEnded = true;
			closeActiveBatch();
			const final = drainFinished();
			// Fire-and-forget shutdown — InMemorySpanExporter has no real resources to release,
			// and we don't want disconnect() to await.
			void provider.shutdown();
			return final;
		},
	};
}
