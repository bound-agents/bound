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

type ExportResult = { code: number; error?: Error };
type Warning = { message: string; context?: Record<string, unknown> };

/** Fake exporter that replays a scripted result sequence, optionally asynchronously. */
function scriptedExporter(results: ExportResult[], opts: { async?: boolean } = {}) {
	let i = 0;
	return {
		export: (_spans: unknown[], callback: (result: ExportResult) => void) => {
			const result = results[i++] ?? { code: 0 };
			if (opts.async) setTimeout(() => callback(result), 0);
			else callback(result);
		},
		shutdown: async () => undefined,
	};
}

function recordingLogger(warnings: Warning[]) {
	return {
		warn(message: string, context?: Record<string, unknown>) {
			warnings.push({ message, context });
		},
	};
}

const fail = (): ExportResult => ({ code: 1, error: new Error("collector unavailable") });
const ok = (): ExportResult => ({ code: 0 });

const failedWarning = (errorClass = "Error"): Warning => ({
	message: "Remote span re-export failed",
	context: { span_count: 1, result_code: 1, error_class: errorClass },
});
const recoveredWarning = (suppressed: number, errorClass = "Error"): Warning => ({
	message: "Remote span re-export recovered",
	context: { error_class: errorClass, suppressed_failures: suppressed },
});

function runSequence(results: ExportResult[]): Warning[] {
	const warnings: Warning[] = [];
	const exporter = scriptedExporter(results);
	const logger = recordingLogger(warnings);
	for (let n = 0; n < results.length; n++) reExportSpans([span], exporter as never, logger);
	return warnings;
}

describe("reExportSpans", () => {
	it("deduplicates repeated exporter failures and reports suppressed batches on recovery", () => {
		const warnings = runSequence([fail(), fail(), fail(), fail(), ok()]);
		expect(warnings).toEqual([failedWarning(), recoveredWarning(3)]);
		expect(JSON.stringify(warnings)).not.toContain("must-not-log");
	});

	it("warns with safe batch metadata when remote span export fails", () => {
		const warnings = runSequence([fail()]);
		expect(warnings).toEqual([failedWarning()]);
		expect(JSON.stringify(warnings)).not.toContain("must-not-log");
	});

	it("logs recovery after a single failed batch", () => {
		expect(runSequence([fail(), ok()])).toEqual([failedWarning(), recoveredWarning(0)]);
	});

	it("logs recovery with one suppressed failure after two failed batches", () => {
		expect(runSequence([fail(), fail(), ok()])).toEqual([failedWarning(), recoveredWarning(1)]);
	});

	it("logs only the first of four consecutive failures", () => {
		expect(runSequence([fail(), fail(), fail(), fail()])).toEqual([failedWarning()]);
	});

	it("logs recovery once per failure episode", () => {
		expect(runSequence([fail(), ok(), ok(), fail(), ok()])).toEqual([
			failedWarning(),
			recoveredWarning(0),
			failedWarning(),
			recoveredWarning(0),
		]);
	});

	it("tracks failure episodes independently per exporter", () => {
		const warnings: Warning[] = [];
		const logger = recordingLogger(warnings);
		const a = scriptedExporter([fail(), ok()]);
		const b = scriptedExporter([fail(), fail()]);
		reExportSpans([span], a as never, logger);
		reExportSpans([span], b as never, logger);
		reExportSpans([span], b as never, logger);
		reExportSpans([span], a as never, logger);
		expect(warnings).toEqual([failedWarning(), failedWarning(), recoveredWarning(0)]);
	});

	it("handles asynchronous exporter callbacks", async () => {
		const warnings: Warning[] = [];
		const logger = recordingLogger(warnings);
		const exporter = scriptedExporter([fail(), ok()], { async: true });
		reExportSpans([span], exporter as never, logger);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(warnings).toEqual([failedWarning()]);
		reExportSpans([span], exporter as never, logger);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(warnings).toEqual([failedWarning(), recoveredWarning(0)]);
	});

	it("preserves nested aggregate error codes in the error class", () => {
		const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:4318"), {
			code: "ECONNREFUSED",
		});
		const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		const aggregate = new AggregateError([refused, reset, refused], "all attempts failed");
		const warnings = runSequence([{ code: 1, error: aggregate }, ok()]);
		expect(warnings).toEqual([
			failedWarning("AggregateError[ECONNREFUSED,ECONNRESET]"),
			recoveredWarning(0, "AggregateError[ECONNREFUSED,ECONNRESET]"),
		]);
	});

	it("preserves an HTTP status code from an exporter error", () => {
		class OTLPExporterError extends Error {
			constructor(
				message: string,
				readonly code: number,
				readonly data: string,
			) {
				super(message);
				this.name = "OTLPExporterError";
			}
		}
		const error = new OTLPExporterError("Service Unavailable", 503, "upstream body");
		expect(runSequence([{ code: 1, error }])).toEqual([failedWarning("OTLPExporterError[503]")]);
	});

	it("follows error causes for codes", () => {
		const cause = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
		const error = new TypeError("fetch failed", { cause });
		expect(runSequence([{ code: 1, error }])).toEqual([failedWarning("TypeError[ENOTFOUND]")]);
	});

	it("redacts messages, endpoints, headers, span data, and non-allowlisted codes", () => {
		const secretUrl = "https://collector.internal.example:4318/v1/traces?token=abc123";
		const nested = Object.assign(new Error(`connect failed ${secretUrl}`), {
			code: secretUrl,
			headers: { authorization: "Bearer sekrit" },
		});
		const many = Array.from({ length: 10 }, (_, n) =>
			Object.assign(new Error("x"), { code: `ECODE${n}` }),
		);
		const error = Object.assign(new AggregateError([nested, ...many], secretUrl), {
			code: "lowercase-not-allowed",
		});
		const warnings = runSequence([{ code: 1, error }]);
		const serialized = JSON.stringify(warnings);
		for (const leak of [
			"must-not-log",
			"collector.internal",
			"abc123",
			"Bearer",
			"sekrit",
			"connect failed",
			"lowercase-not-allowed",
		]) {
			expect(serialized).not.toContain(leak);
		}
		expect(warnings).toEqual([failedWarning("AggregateError[ECODE0,ECODE1,ECODE2,ECODE3]")]);
	});

	it("bounds an arbitrary error name", () => {
		const error = new Error("boom");
		error.name = `Custom ${"x".repeat(200)} https://leak.example`;
		const [warning] = runSequence([{ code: 1, error }]);
		expect(warning?.context?.error_class).toBe("Error");
	});
});
