import { afterEach, describe, expect, it } from "bun:test";
import {
	configureLessTelemetry,
	configureLessTelemetryFromOpenTelemetry,
	withLessTelemetry,
} from "../telemetry";

afterEach(() => configureLessTelemetry());

describe("less telemetry", () => {
	it("wires OpenTelemetry instruments into Less telemetry", async () => {
		const calls: string[] = [];
		configureLessTelemetryFromOpenTelemetry({
			startSpan: () => ({
				addEvent() {},
				recordException() {},
				setStatus() {},
				end() {
					calls.push("span.end");
				},
			}),
			operation: { add: () => calls.push("operation.add") },
			duration: { record: () => calls.push("duration.record") },
		});

		await withLessTelemetry("boundless.transport.attach", {}, async () => undefined);

		expect(calls).toEqual(["operation.add", "duration.record", "span.end"]);
	});

	it("records an error outcome when a completed tool result has isError true", async () => {
		const statuses: Array<{ code: number }> = [];
		const outcomes: string[] = [];
		configureLessTelemetry({
			startSpan: () => ({
				addEvent() {},
				recordException() {},
				setStatus(status) {
					statuses.push(status);
				},
				end() {},
			}),
			operation: {
				add(_value, attributes) {
					outcomes.push(attributes["operation.outcome"]);
				},
			},
			duration: { record() {} },
		});

		await withLessTelemetry("boundless.tool.call", {}, async () => ({ isError: true }));

		expect(outcomes).toEqual(["error"]);
		expect(statuses).toEqual([{ code: 2 }]);
	});
});
