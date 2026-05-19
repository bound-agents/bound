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

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

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
