import { type Context, ROOT_CONTEXT, SpanKind, type Tracer, trace } from "@opentelemetry/api";

export function startClientToolResultReceive(
	tracer: Tracer,
	dispatchContext: Context | undefined,
	attributes: { isError: boolean; hasTraceData: boolean },
) {
	const linkedSpan = dispatchContext ? trace.getSpanContext(dispatchContext) : undefined;
	return tracer.startSpan(
		"client-tool.result.receive",
		{
			kind: SpanKind.CONSUMER,
			attributes: {
				"bound.client_tool.result.error": attributes.isError,
				"bound.client_tool.result.trace_data": attributes.hasTraceData,
			},
			links: linkedSpan ? [{ context: linkedSpan }] : [],
		},
		ROOT_CONTEXT,
	);
}

export function startSessionHostHandoff(tracer: Tracer, carrierContext: Context | undefined) {
	return tracer.startSpan(
		"client-tool.session-host.handoff",
		{ kind: SpanKind.PRODUCER },
		carrierContext ?? ROOT_CONTEXT,
	);
}
