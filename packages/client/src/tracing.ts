import { createScopedTraceCollector, extractTraceContext, runInTraceContext } from "@bound/shared";

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

	let result: T | undefined;

	await runInTraceContext(parentContext, async () => {
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
		result: result as T,
		traceData: spans.length > 0 ? JSON.stringify(spans) : undefined,
	};
}
