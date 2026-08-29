import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
	MeterProvider,
	type MetricReader,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	SimpleSpanProcessor,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SiteIdSpanProcessor } from "./site-id-span-processor";
import { clearTelemetryInstrumentCaches } from "./telemetry-api";
import { setTraceExporter } from "./trace-exporter-context";

export { counter, histogram, meter, upDownCounter } from "./telemetry-api";

let provider: BasicTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;
let siteIdProcessor: SiteIdSpanProcessor | null = null;
let contextManager: AsyncLocalStorageContextManager | null = null;
let ownership = { trace: false, metrics: false, context: false };
let shutdownPromise: Promise<void> | null = null;

export interface TelemetryOptions {
	enabled?: boolean;
	traceExporter?: SpanExporter;
	metricReader?: MetricReader;
	resourceAttributes?: Record<string, string | number | boolean>;
}

function isEnabled(value: string | undefined): boolean {
	return value === "true" || value === "1";
}

function signalEndpoint(signal: "traces" | "metrics"): string | undefined {
	const specific =
		signal === "traces"
			? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
			: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
	if (specific?.trim()) return specific.trim();
	const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	if (!base) return undefined;
	return `${base.replace(/\/+$/, "")}/v1/${signal}`;
}

/**
 * Initialize Bun-compatible manual OpenTelemetry tracing and metrics.
 *
 * The second argument accepts either the options API or the historical positional
 * SpanExporter used by tests and embedders.
 */
export function initTelemetry(serviceName: string, options?: TelemetryOptions): void;
export function initTelemetry(serviceName: string, traceExporter?: SpanExporter): void;
export function initTelemetry(
	serviceName: string,
	options: TelemetryOptions | SpanExporter = {},
): void {
	if (provider || meterProvider || shutdownPromise) return;
	const normalized: TelemetryOptions =
		typeof (options as SpanExporter).export === "function"
			? { traceExporter: options as SpanExporter }
			: (options as TelemetryOptions);
	const enabled = normalized.enabled ?? isEnabled(process.env.OTEL_ENABLED);
	if (!enabled) return;

	const resource = Resource.default().merge(
		new Resource({
			[ATTR_SERVICE_NAME]: serviceName,
			...normalized.resourceAttributes,
		}),
	);

	const nextProvider = new BasicTracerProvider({ resource });
	const nextSiteIdProcessor = new SiteIdSpanProcessor();
	nextProvider.addSpanProcessor(nextSiteIdProcessor);
	const nextExporter =
		normalized.traceExporter ??
		new OTLPTraceExporter(signalEndpoint("traces") ? { url: signalEndpoint("traces") } : undefined);
	nextProvider.addSpanProcessor(
		normalized.traceExporter
			? new SimpleSpanProcessor(nextExporter)
			: new BatchSpanProcessor(nextExporter),
	);

	const metricsEndpoint = signalEndpoint("metrics");
	const metricReader =
		normalized.metricReader ??
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter(metricsEndpoint ? { url: metricsEndpoint } : undefined),
		});
	const nextMeterProvider = new MeterProvider({ resource, readers: [metricReader] });
	const nextContextManager = new AsyncLocalStorageContextManager();

	let ownsMetrics = false;
	let ownsContext = false;
	let ownsTrace = false;
	try {
		ownsMetrics = metrics.setGlobalMeterProvider(nextMeterProvider);
		nextContextManager.enable();
		ownsContext = context.setGlobalContextManager(nextContextManager);
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		ownsTrace = trace.setGlobalTracerProvider(nextProvider);
	} catch (error) {
		void Promise.allSettled([nextProvider.shutdown(), nextMeterProvider.shutdown()]);
		nextContextManager.disable();
		throw error;
	}

	provider = nextProvider;
	meterProvider = nextMeterProvider;
	siteIdProcessor = nextSiteIdProcessor;
	contextManager = nextContextManager;
	ownership = { trace: ownsTrace, metrics: ownsMetrics, context: ownsContext };
	setTraceExporter(nextExporter);
}

export function setTelemetrySiteId(siteId: string): void {
	siteIdProcessor?.setSiteId(siteId);
}

/** Flush and shut down both signal providers. Concurrent calls share one cleanup. */
export function shutdownTelemetry(): Promise<void> {
	if (shutdownPromise) return shutdownPromise;
	const activeProvider = provider;
	const activeMeterProvider = meterProvider;
	const activeContextManager = contextManager;
	if (!activeProvider && !activeMeterProvider) return Promise.resolve();

	const activeOwnership = ownership;
	shutdownPromise = (async () => {
		const errors: unknown[] = [];
		for (const operation of [
			() => activeProvider?.forceFlush(),
			() => activeMeterProvider?.forceFlush(),
			() => activeProvider?.shutdown(),
			() => activeMeterProvider?.shutdown(),
		]) {
			try {
				await operation();
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			if (activeOwnership.trace) trace.disable();
			if (activeOwnership.metrics) metrics.disable();
			if (activeOwnership.context) context.disable();
			activeContextManager?.disable();
		} finally {
			provider = null;
			meterProvider = null;
			siteIdProcessor = null;
			contextManager = null;
			ownership = { trace: false, metrics: false, context: false };
			clearTelemetryInstrumentCaches();
			setTraceExporter(null);
			shutdownPromise = null;
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Telemetry shutdown failed");
	})();
	return shutdownPromise;
}
