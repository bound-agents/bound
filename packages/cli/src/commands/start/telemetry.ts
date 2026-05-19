import { setTraceExporter } from "@bound/shared";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	SimpleSpanProcessor,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let provider: BasicTracerProvider | null = null;
let exporter: SpanExporter | null = null;

/**
 * Initialize OpenTelemetry tracing when OTEL_ENABLED is set.
 * Registers a BasicTracerProvider with BatchSpanProcessor exporting to OTLP HTTP.
 * When OTEL_ENABLED is not set, this is a no-op — the @opentelemetry/api returns
 * no-op spans by design, guaranteeing zero overhead.
 *
 * @param serviceName The service name to use for the trace resource
 * @param testExporter Optional exporter for testing (uses SimpleSpanProcessor instead of BatchSpanProcessor)
 */
export function initTelemetry(serviceName: string, testExporter?: SpanExporter): void {
	if (!process.env.OTEL_ENABLED) return;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

	const resource = Resource.default().merge(
		new Resource({
			[ATTR_SERVICE_NAME]: serviceName,
		}),
	);

	provider = new BasicTracerProvider({ resource });

	if (testExporter) {
		// For testing: use SimpleSpanProcessor for immediate export
		exporter = testExporter;
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	} else {
		// For production: use BatchSpanProcessor with OTLP HTTP exporter
		exporter = new OTLPTraceExporter({
			url: `${endpoint}/v1/traces`,
		});
		provider.addSpanProcessor(new BatchSpanProcessor(exporter));
	}

	// Register exporter globally for spoke-side re-export of hub traces (AC5.4)
	setTraceExporter(exporter);

	// Register an AsyncLocalStorage-based context manager so that
	// context.active() propagates parent spans across async boundaries.
	// Without this, every span becomes an independent root trace.
	const contextManager = new AsyncLocalStorageContextManager();
	contextManager.enable();
	context.setGlobalContextManager(contextManager);

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
	exporter = null;

	// Clear global OTel registrations so subsequent spans are non-recording
	trace.disable();
	context.disable();
	setTraceExporter(null);
}
