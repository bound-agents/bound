import { createScopedTraceCollector, extractTraceContext, runInTraceContext } from "@bound/shared";
import { SpanStatusCode } from "@opentelemetry/api";

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
 * If trace context is malformed, executes without tracing (observability never blocks execution).
 */
export async function withClientToolTracing<T>(
	traceContextStr: string | undefined,
	fn: () => Promise<T>,
): Promise<ClientToolTracingResult<T>> {
	if (!traceContextStr) {
		const result = await fn();
		return { result, traceData: undefined };
	}

	// Parse trace context — if malformed, fall back to plain execution.
	// Tracing setup errors must never block tool execution.
	let carrier: Record<string, string>;
	try {
		carrier = JSON.parse(traceContextStr) as Record<string, string>;
	} catch {
		const result = await fn();
		return { result, traceData: undefined };
	}

	const parentContext = extractTraceContext(carrier);
	const collector = createScopedTraceCollector();
	const tracer = collector.getTracer("bound.client-tool");

	let result: T | undefined;

	await runInTraceContext(parentContext, async () => {
		const span = tracer.startSpan("client-tool.execute", {}, parentContext);
		try {
			result = await fn();
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (err) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			span.end();
		}
	});

	const spans = await collector.flush();
	return {
		result: result as T,
		traceData: spans.length > 0 ? JSON.stringify(spans) : undefined,
	};
}
