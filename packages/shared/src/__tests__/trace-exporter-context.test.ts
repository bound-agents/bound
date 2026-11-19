import { afterEach, describe, expect, it } from "bun:test";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { getTraceExporter, setTraceExporter } from "../trace-exporter-context";

// Restore the module-global holder after each test so ordering is irrelevant.
afterEach(() => {
	setTraceExporter(null);
});

function fakeExporter(): SpanExporter {
	return {
		export: () => {},
		shutdown: async () => {},
	} as unknown as SpanExporter;
}

describe("trace exporter holder", () => {
	it("defaults to null before anything is set", () => {
		setTraceExporter(null);
		expect(getTraceExporter()).toBeNull();
	});

	it("getTraceExporter returns the exporter that setTraceExporter stored", () => {
		const exporter = fakeExporter();
		setTraceExporter(exporter);
		expect(getTraceExporter()).toBe(exporter);
	});

	it("setTraceExporter(null) clears a previously set exporter", () => {
		setTraceExporter(fakeExporter());
		setTraceExporter(null);
		expect(getTraceExporter()).toBeNull();
	});
});
