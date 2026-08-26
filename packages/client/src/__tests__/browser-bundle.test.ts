import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const CLIENT_ROOT = new URL("../..", import.meta.url).pathname;
const NODE_ONLY_TELEMETRY_SIGNATURES = [
	"@opentelemetry/context-async-hooks",
	"@opentelemetry/exporter-trace-otlp-http",
	"@opentelemetry/exporter-metrics-otlp-http",
	"OTLPTraceExporter",
	"OTLPMetricExporter",
	"AsyncLocalStorageContextManager",
];

describe("browser bundle", () => {
	it("does not contain Node-only telemetry SDK or exporter code", async () => {
		const directory = await mkdtemp(join(CLIENT_ROOT, ".browser-bundle-"));
		try {
			const result =
				await Bun.$`bun build src/index.ts --outdir ${directory} --target browser --packages bundle`
					.cwd(CLIENT_ROOT)
					.quiet();
			expect(result.exitCode).toBe(0);
			const bundle = await readFile(join(directory, "index.js"), "utf8");
			for (const signature of NODE_ONLY_TELEMETRY_SIGNATURES) {
				expect(bundle).not.toContain(signature);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
