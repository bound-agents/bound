import { afterEach, describe, expect, it } from "bun:test";
import {
	type CoreTelemetry,
	recordChangeLogPostcommitEvent,
	recordChangeLogTransaction,
	setCoreTelemetry,
	withCoreSpan,
} from "../telemetry";

interface SpanCall {
	exception?: Error;
	status?: { code: number; message?: string };
	ended: boolean;
}

/**
 * A recording CoreTelemetry double. Every counter add and span lifecycle event
 * is captured so tests can assert the real control flow of withCoreSpan and the
 * record* helpers rather than touching the global OTel SDK.
 */
function makeRecorder(): {
	telemetry: CoreTelemetry;
	counters: Record<string, Array<{ value: number; attributes?: Record<string, string | number> }>>;
	spans: SpanCall[];
} {
	const counters: Record<
		string,
		Array<{ value: number; attributes?: Record<string, string | number> }>
	> = {
		changeLogTransactions: [],
		changeLogPostcommitEvents: [],
	};
	const spans: SpanCall[] = [];

	const telemetry: CoreTelemetry = {
		changeLogTransactions: {
			add(value, attributes) {
				counters.changeLogTransactions.push({ value, attributes });
			},
		},
		changeLogPostcommitEvents: {
			add(value, attributes) {
				counters.changeLogPostcommitEvents.push({ value, attributes });
			},
		},
		startSpan() {
			const call: SpanCall = { ended: false };
			spans.push(call);
			return {
				recordException(error) {
					call.exception = error;
				},
				setStatus(status) {
					call.status = status;
				},
				end() {
					call.ended = true;
				},
			};
		},
	};

	return { telemetry, counters, spans };
}

describe("core telemetry", () => {
	afterEach(() => {
		// Restore the noop telemetry so tests don't leak the OTel-backed default.
		setCoreTelemetry();
	});

	describe("withCoreSpan — success path", () => {
		it("runs the callback, marks OK, ends the span, and returns the value (fn-only overload)", () => {
			const { telemetry, spans } = makeRecorder();
			setCoreTelemetry(telemetry);

			const result = withCoreSpan("changelog.transaction", (span) => {
				expect(span).toBeDefined();
				return 42;
			});

			expect(result).toBe(42);
			expect(spans).toHaveLength(1);
			// SpanStatusCode.OK === 1
			expect(spans[0].status).toEqual({ code: 1 });
			expect(spans[0].exception).toBeUndefined();
			expect(spans[0].ended).toBe(true);
		});

		it("accepts the (name, attributes, fn) overload", () => {
			const { telemetry, spans } = makeRecorder();
			setCoreTelemetry(telemetry);

			const result = withCoreSpan(
				"durable_work.operation",
				{ operation: "read", count: 3 },
				() => "done",
			);

			expect(result).toBe("done");
			expect(spans[0].status).toEqual({ code: 1 });
			expect(spans[0].ended).toBe(true);
		});
	});

	describe("withCoreSpan — error path", () => {
		it("records the exception, marks ERROR, ends the span, and rethrows", () => {
			const { telemetry, spans } = makeRecorder();
			setCoreTelemetry(telemetry);

			const boom = new Error("kaboom");
			expect(() =>
				withCoreSpan("durable_work.operation", () => {
					throw boom;
				}),
			).toThrow("kaboom");

			expect(spans[0].exception).toBe(boom);
			// SpanStatusCode.ERROR === 2
			expect(spans[0].status).toEqual({ code: 2, message: "kaboom" });
			// span is still ended via finally
			expect(spans[0].ended).toBe(true);
		});

		it("wraps a non-Error throw into an Error for recordException", () => {
			const { telemetry, spans } = makeRecorder();
			setCoreTelemetry(telemetry);

			expect(() =>
				withCoreSpan("changelog.transaction", () => {
					throw "a string";
				}),
			).toThrow("a string");

			expect(spans[0].exception).toBeInstanceOf(Error);
			expect(spans[0].exception?.message).toBe("a string");
			expect(spans[0].status).toEqual({ code: 2, message: "a string" });
		});

		it("throws TypeError when the attributes overload is given no callback", () => {
			const { telemetry } = makeRecorder();
			setCoreTelemetry(telemetry);
			const twoArg = withCoreSpan as unknown as (name: string, attrs: object) => unknown;
			expect(() => twoArg("changelog.transaction", { k: "v" })).toThrow(TypeError);
		});
	});

	describe("record helpers route to the active telemetry", () => {
		it("recordChangeLogTransaction adds 1 with the outcome attribute", () => {
			const { telemetry, counters } = makeRecorder();
			setCoreTelemetry(telemetry);
			recordChangeLogTransaction("committed");
			recordChangeLogTransaction("failed");
			expect(counters.changeLogTransactions).toEqual([
				{ value: 1, attributes: { outcome: "committed" } },
				{ value: 1, attributes: { outcome: "failed" } },
			]);
		});

		it("recordChangeLogPostcommitEvent adds 1 with the outcome attribute", () => {
			const { telemetry, counters } = makeRecorder();
			setCoreTelemetry(telemetry);
			recordChangeLogPostcommitEvent("succeeded");
			expect(counters.changeLogPostcommitEvents).toEqual([
				{ value: 1, attributes: { outcome: "succeeded" } },
			]);
		});
	});

	describe("setCoreTelemetry() with no argument installs noops", () => {
		it("does not throw and spans still end under the noop implementation", () => {
			setCoreTelemetry();
			// record helpers are safe no-ops
			expect(() => recordChangeLogTransaction("committed")).not.toThrow();
			// withCoreSpan still returns the callback value via the noop span
			expect(withCoreSpan("changelog.transaction", () => "ok")).toBe("ok");
		});
	});
});
