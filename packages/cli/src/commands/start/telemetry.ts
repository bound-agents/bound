// Re-export the shared telemetry init/shutdown so existing internal imports
// continue to work. The implementation lives in `@bound/shared/telemetry`
// so other binaries (boundless, bound-mcp) can use the same setup.
export { initTelemetry, shutdownTelemetry } from "@bound/shared";
