import { context, propagation, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SiteIdSpanProcessor } from "./site-id-span-processor.js";

export interface SerializedLink {
	traceId: string;
	spanId: string;
	traceFlags?: number;
	attributes?: Record<string, unknown>;
}

export interface SerializedSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | undefined;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Record<string, unknown>;
	status: { code: number; message?: string };
	events: Array<{
		name: string;
		attributes?: Record<string, unknown>;
		timeUnixNano: string;
	}>;
	/** Optional cross-trace links (e.g. client-side spans linking back to the server SpanContext). */
	links?: SerializedLink[];
}

/**
 * Convert an OTel ReadableSpan into the wire `SerializedSpan` shape.
 * Shared between in-process collectors and per-call wrappers.
 */
export function serializeReadableSpan(span: ReadableSpan): SerializedSpan {
	const ctx = span.spanContext();
	return {
		traceId: ctx.traceId,
		spanId: ctx.spanId,
		parentSpanId: span.parentSpanId,
		name: span.name,
		kind: span.kind,
		startTimeUnixNano: hrTimeToNano(span.startTime),
		endTimeUnixNano: hrTimeToNano(span.endTime),
		attributes: span.attributes as Record<string, unknown>,
		status: span.status,
		events: span.events.map((e) => ({
			name: e.name,
			attributes: e.attributes as Record<string, unknown> | undefined,
			timeUnixNano: hrTimeToNano(e.time),
		})),
		links: (span.links ?? []).map((l) => ({
			traceId: l.context.traceId,
			spanId: l.context.spanId,
			traceFlags: l.context.traceFlags,
			attributes: l.attributes as Record<string, unknown> | undefined,
		})),
	};
}

/**
 * Create a scoped trace collector that buffers spans in memory.
 * Used by hub nodes processing relay requests with trace_context —
 * the hub does NOT need OTEL_ENABLED or a global provider.
 *
 * When `siteId` is provided, every span created through this collector is stamped
 * with the `bound.site_id` attribute (issue #152). For hub-side relay inference this
 * is the *executing* hub's site ID, which survives serialization back to the
 * requesting spoke's `reExportSpans` (span attributes are preserved on the wire,
 * unlike the resource), so a re-exported delegated-inference span arrives tagged
 * with the site that actually ran the loop.
 */
export function createScopedTraceCollector(siteId?: string) {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	if (siteId) {
		provider.addSpanProcessor(new SiteIdSpanProcessor(siteId));
	}
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

	return {
		provider,
		/**
		 * Get a tracer from this scoped provider (not the global one).
		 */
		getTracer(name: string) {
			return provider.getTracer(name);
		},
		/**
		 * Serialize all buffered spans and shut down the provider.
		 */
		async flush(): Promise<SerializedSpan[]> {
			await provider.forceFlush();
			const serialized = exporter.getFinishedSpans().map(serializeReadableSpan);
			await provider.shutdown();
			return serialized;
		},
	};
}

/**
 * Extract trace context from a carrier object (W3C traceparent format).
 * Parses the traceparent header directly to construct a SpanContext,
 * avoiding dependency on a globally-registered propagator.
 * Returns a context with the extracted span, or the current context if carrier is null.
 */
export function extractTraceContext(
	carrier: Record<string, string> | null,
): ReturnType<typeof context.active> {
	if (!carrier) return context.active();

	// Try the propagation API first (works when a global propagator is registered)
	const extracted = propagation.extract(context.active(), carrier);
	const extractedSpan = trace.getSpan(extracted);
	if (extractedSpan && extractedSpan.spanContext().traceId !== "00000000000000000000000000000000") {
		return extracted;
	}

	// Fallback: manually parse W3C traceparent header
	// Format: version-traceId-spanId-traceFlags (e.g., 00-0af7...-b7ad...-01)
	const traceparent = carrier.traceparent;
	if (!traceparent) return context.active();

	const parts = traceparent.split("-");
	if (parts.length < 4) return context.active();

	const [, traceId, spanId, flags] = parts;
	if (!traceId || !spanId || traceId.length !== 32 || spanId.length !== 16) {
		return context.active();
	}

	const spanContext = {
		traceId,
		spanId,
		traceFlags: Number.parseInt(flags, 16) || 0,
		isRemote: true,
	};

	return trace.setSpanContext(context.active(), spanContext);
}

/**
 * Inject active trace context into a carrier object.
 * Returns null if no active span exists.
 */
export function injectTraceContext(): Record<string, string> | null {
	const span = trace.getActiveSpan();
	if (!span) return null;
	const carrier: Record<string, string> = {};
	propagation.inject(context.active(), carrier);
	if (!carrier.traceparent) return null;
	return carrier;
}

/**
 * Run a function within a specific trace context.
 * This is used by clients to execute code within the parent trace context
 * extracted from a server's injected trace_context.
 */
export async function runInTraceContext<T>(
	ctx: ReturnType<typeof context.active>,
	fn: () => Promise<T>,
): Promise<T> {
	return context.with(ctx, fn);
}

function hrTimeToNano(hrTime: [number, number]): string {
	return String(hrTime[0] * 1_000_000_000 + hrTime[1]);
}
