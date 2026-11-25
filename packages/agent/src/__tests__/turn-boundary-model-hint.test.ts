import { describe, expect, it } from "bun:test";
import { refreshModelHintAtTurnBoundary } from "../agent-loop-utils";

it("treats an omitted model and the symbolic default as the same hint (no reset)", () => {
	const config: { modelId?: string } = {};
	let invalidations = 0;
	for (let turn = 0; turn < 3; turn++) {
		expect(
			refreshModelHintAtTurnBoundary(
				config,
				() => "default",
				() => invalidations++,
			),
		).toBe(false);
	}
	expect(invalidations).toBe(0);
	expect(config.modelId).toBeUndefined();
});
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
