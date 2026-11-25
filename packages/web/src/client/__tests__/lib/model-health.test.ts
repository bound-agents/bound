import { describe, expect, it } from "bun:test";
import { HEALTH_STATE_LABELS, modelHealthState, routeHealthLabel } from "../../lib/model-health";

describe("model-health", () => {
	it("classifies model state", () => {
		expect(modelHealthState(undefined)).toBe("unknown");
		expect(modelHealthState([{ drained: true, health: "healthy" }])).toBe("none");
		expect(modelHealthState([{ drained: false, health: "backoff" }])).toBe("degraded");
		expect(modelHealthState([{ drained: false, health: "healthy" }])).toBe("healthy");
		expect(HEALTH_STATE_LABELS.unknown).toBe("Unknown");
	});
	it("labels routes with one vocabulary", () => {
		expect(routeHealthLabel({ drained: true, health: "healthy" })).toBe("Disabled");
		expect(routeHealthLabel({ drained: false, health: "half_open" })).toBe("Retrying");
		expect(routeHealthLabel({ drained: false, health: "unknown" })).toBe("Unknown");
		expect(routeHealthLabel({ drained: false, health: "backoff", next_trial_at: 120_000 }, 0)).toBe(
			"Backing off, retrying in 2m",
		);
	});
});
