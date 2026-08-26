// Re-export the shared telemetry bootstrap and metric helpers so existing CLI
// imports keep one process-wide provider implementation.
export {
	counter,
	histogram,
	initTelemetry,
	meter,
	setTelemetrySiteId,
	shutdownTelemetry,
	type TelemetryOptions,
} from "@bound/shared";
