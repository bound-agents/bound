import { describe, expect, it } from "bun:test";
import { refreshModelHintAtTurnBoundary } from "../agent-loop-utils";

describe("refreshModelHintAtTurnBoundary", () => {
	it("picks up a changed task hint and does not churn an unchanged hint", () => {
		const config = { modelId: "old" };
		let reads = 0;
		let invalidations = 0;
		const read = () => {
			reads++;
			return reads === 1 ? "old" : "new";
		};
		expect(refreshModelHintAtTurnBoundary(config, read, () => invalidations++)).toBe(false);
		expect(refreshModelHintAtTurnBoundary(config, read, () => invalidations++)).toBe(true);
		expect(config.modelId).toBe("new");
		expect(invalidations).toBe(1);
		expect(
			refreshModelHintAtTurnBoundary(
				config,
				() => "new",
				() => invalidations++,
			),
		).toBe(false);
		expect(invalidations).toBe(1);
	});
});
