import { describe, expect, it } from "bun:test";
import {
	recordAgentOperationalMetric,
	recordSchedulerClaimDelay,
	recordSchedulerExecutionDuration,
	recordSchedulerQueueDelay,
	setAgentMetricRecorderForTest,
} from "../operational-metrics";

describe("agent operational metrics", () => {
	it("records bounded outcomes and scheduler lifecycle timings in seconds", () => {
		const records: Array<{
			name: string;
			value: number;
			attributes: Record<string, string>;
		}> = [];
		setAgentMetricRecorderForTest((name, value, attributes) =>
			records.push({ name, value, attributes }),
		);

		recordAgentOperationalMetric("scheduler", { outcome: "soft_failed", type: "event" });
		recordSchedulerQueueDelay(1_500, { type: "event" });
		recordSchedulerClaimDelay(250, { type: "event" });
		recordSchedulerExecutionDuration(2_000, { type: "event", outcome: "soft_failed" });

		expect(records).toEqual([
			{ name: "scheduler", value: 1, attributes: { outcome: "soft_failed", type: "event" } },
			{ name: "scheduler_queue", value: 1.5, attributes: { type: "event" } },
			{ name: "scheduler_claim", value: 0.25, attributes: { type: "event" } },
			{
				name: "scheduler_execution",
				value: 2,
				attributes: { type: "event", outcome: "soft_failed" },
			},
		]);
		setAgentMetricRecorderForTest();
	});
});
