import { type SerializedSpan, extractTraceContext, serializeReadableSpan } from "@bound/shared";
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
 * The session owns a single `BasicTracerProvider` for the connection's lifetime
 * — providers are expensive to construct, so we don't recreate one per call —
 * but emits no spans of its own. Each `wrapToolCall` extracts the server's
 * SpanContext from the carrier and parents `client-tool.execute` directly under
 * it, so parallel/serial sibling calls naturally group under the agent loop's
 * `tool-execute` span on a single unified Jaeger trace.
 *
 * The previous `boundless.session` span has been removed: it conflated
 * connection lifetime with per-turn lifetime (it rolled per-traceparent), and
 * once children parent under the server SpanContext directly, sibling grouping
 * happens automatically via the carrier — the session span added a layer of
 * indirection that misrepresented causality (it appeared to be the parent of a
 * tool-execute span that had actually caused it).
 */
export interface ClientTracingSession {
	/**
	 * Wrap a single tool call with tracing. Returns the tool's result plus any
	 * spans that completed during this call (serialized for shipping back to the
	 * server).
	 *
	 * If `traceContextStr` is missing, malformed, or has no `traceparent`,
	 * executes `fn` without tracing overhead and returns `traceData: undefined`.
	 * Tracing setup failures must never block tool execution.
	 */
	wrapToolCall<T>(
		traceContextStr: string | undefined,
		fn: () => Promise<T>,
		options?: WrapToolCallOptions,
	): Promise<ClientToolTracingResult<T>>;

	/**
	 * Shut down the underlying provider (fire-and-forget). Idempotent —
	 * subsequent calls return `[]`. The return type is preserved for back-compat
	 * with callers that previously needed to ship a trailing batch span; with
	 * the session span removed, every `client-tool.execute` ships on its own
	 * `span.end()` and there is nothing trailing to flush.
	 */
	end(): SerializedSpan[];
}

export function createClientTracingSession(): ClientTracingSession {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	const tracer = provider.getTracer("bound.client-tool");

	let sessionEnded = false;

	const drainFinished = (): SerializedSpan[] => {
		const finished = exporter.getFinishedSpans();
		exporter.reset();
		return finished.map(serializeReadableSpan);
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

			if (!carrier.traceparent) {
				const result = await fn();
				return { result, traceData: undefined };
			}

			const linkedCtx = extractTraceContext(carrier);

			// Parent client-tool.execute directly under the server's SpanContext
			// (typically agent-loop.tool-execute). Sibling client tool calls under
			// the same server traceparent share that same parent automatically.
			//
			// We deliberately do NOT emit an OTel Link to the same SpanContext.
			// The carrier's traceparent is the only path into this branch (we
			// early-return above when missing), so the parent reference already
			// covers cross-trace nav. A redundant Link causes the OTLP receiver
			// in Jaeger to surface the relationship as FOLLOWS_FROM rather than
			// CHILD_OF — the Link wins over the parentSpanId and the span shows
			// up as an orphan root in the Jaeger trace tree.
			const span = tracer.startSpan(
				"client-tool.execute",
				{
					kind: SpanKind.INTERNAL,
					attributes: options?.toolName ? { "tool.name": options.toolName } : {},
				},
				linkedCtx,
			);

			let result: T;
			try {
				result = await context.with(trace.setSpan(linkedCtx, span), fn);
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
			// Fire-and-forget shutdown — InMemorySpanExporter has no real resources
			// to release, and we don't want disconnect() to await.
			void provider.shutdown();
			return [];
		},
	};
}
