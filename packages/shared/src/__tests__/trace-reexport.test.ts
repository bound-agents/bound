import { describe, expect, it } from "bun:test";
import type { SerializedSpan } from "../trace-collector.js";
import { reExportSpans } from "../trace-reexport.js";

const span: SerializedSpan = {
	traceId: "0af7651916cd43dd8448eb211c80319c",
	spanId: "b7ad6b7169203331",
	name: "remote-operation",
	kind: 0,
	startTimeUnixNano: "1000000000",
	endTimeUnixNano: "2000000000",
	attributes: { secret: "must-not-log" },
	status: { code: 0 },
	events: [],
};

describe("reExportSpans", () => {
	it("deduplicates repeated exporter failures and reports suppressed batches on recovery", () => {
		const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
		let failed = true;
		const exporter = {
			export: (_spans: unknown[], callback: (result: { code: number; error?: Error }) => void) => {
				callback(failed ? { code: 1, error: new Error("collector unavailable") } : { code: 0 });
			},
			shutdown: async () => undefined,
		};
		const logger = {
			warn(message: string, context?: Record<string, unknown>) {
				warnings.push({ message, context });
			},
		};

		reExportSpans([span], exporter as never, logger);
		for (let i = 0; i < 3; i++) reExportSpans([span], exporter as never, logger);
		failed = false;
		reExportSpans([span], exporter as never, logger);

		expect(warnings).toEqual([
			{
				message: "Remote span re-export failed",
				context: {
					span_count: 1,
					result_code: 1,
					error_class: "Error",
				},
			},
			{
				message: "Remote span re-export recovered",
				context: { error_class: "Error", suppressed_failures: 3 },
			},
		]);
		expect(JSON.stringify(warnings)).not.toContain("must-not-log");
	});

	it("warns with safe batch metadata when remote span export fails", () => {
		const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
		const exporter = {
			export: (_spans: unknown[], callback: (result: { code: number; error?: Error }) => void) => {
				callback({ code: 1, error: new Error("collector unavailable") });
			},
			shutdown: async () => undefined,
		};

		reExportSpans([span], exporter as never, {
			warn(message, context) {
				warnings.push({ message, context });
			},
		});

		expect(warnings).toEqual([
			{
				message: "Remote span re-export failed",
				context: {
					span_count: 1,
					result_code: 1,
					error_class: "Error",
				},
			},
		]);
		expect(JSON.stringify(warnings)).not.toContain("must-not-log");
	});
});
