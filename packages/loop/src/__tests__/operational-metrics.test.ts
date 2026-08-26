import { describe, expect, it } from "bun:test";
import { recordLoopOperationalMetric, setLoopMetricRecorderForTest } from "../modular-agent-loop";

describe("loop operational metrics", () => {
	it("records run/turn duration and in-flight values", () => {
		const records: Array<{
			name: string;
			value: number;
			attributes: Record<string, string>;
		}> = [];
		setLoopMetricRecorderForTest((name, value, attributes) =>
			records.push({ name, value, attributes }),
		);

		recordLoopOperationalMetric("in_flight", {}, 1);
		recordLoopOperationalMetric("turn_duration", { outcome: "completed" }, 0.25);
		recordLoopOperationalMetric("run_duration", { outcome: "completed" }, 1.5);
		recordLoopOperationalMetric("in_flight", {}, -1);

		expect(records).toEqual([
			{ name: "in_flight", value: 1, attributes: {} },
			{ name: "turn_duration", value: 0.25, attributes: { outcome: "completed" } },
			{ name: "run_duration", value: 1.5, attributes: { outcome: "completed" } },
			{ name: "in_flight", value: -1, attributes: {} },
		]);
		setLoopMetricRecorderForTest();
	});
});
