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
					error: "collector unavailable",
				},
			},
		]);
		expect(JSON.stringify(warnings)).not.toContain("must-not-log");
	});
});
