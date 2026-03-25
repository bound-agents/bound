import { describe, expect, it } from "bun:test";
import { ReachabilityTracker } from "../reachability.js";

describe("ReachabilityTracker", () => {
	it("initializes unknown hosts as reachable", () => {
		const tracker = new ReachabilityTracker();
		expect(tracker.isReachable("unknown-host")).toBe(true);
	});

	it("records a failure without marking unreachable at count < maxFailures", () => {
		const tracker = new ReachabilityTracker(3);
		tracker.recordFailure("host-1");
		expect(tracker.isReachable("host-1")).toBe(true);

		const state = tracker.getState("host-1");
		expect(state).toBeDefined();
		expect(state?.failureCount).toBe(1);
		expect(state?.reachable).toBe(true);
	});

	it("marks unreachable after reaching maxFailures", () => {
		const tracker = new ReachabilityTracker(3);
		tracker.recordFailure("host-2");
		tracker.recordFailure("host-2");
		expect(tracker.isReachable("host-2")).toBe(true);

		tracker.recordFailure("host-2");
		expect(tracker.isReachable("host-2")).toBe(false);

		const state = tracker.getState("host-2");
		expect(state?.failureCount).toBe(3);
		expect(state?.reachable).toBe(false);
	});

	it("resets state to reachable on successful sync", () => {
		const tracker = new ReachabilityTracker(3);
		tracker.recordFailure("host-3");
		tracker.recordFailure("host-3");
		tracker.recordFailure("host-3");
		expect(tracker.isReachable("host-3")).toBe(false);

		tracker.recordSuccess("host-3");
		expect(tracker.isReachable("host-3")).toBe(true);

		const state = tracker.getState("host-3");
		expect(state?.failureCount).toBe(0);
		expect(state?.reachable).toBe(true);
	});

	it("supports full state transition cycle: reachable → failures → unreachable → success → reachable", () => {
		const tracker = new ReachabilityTracker(3);
		const hostId = "cycle-test";

		// Initially unknown, defaults to reachable
		expect(tracker.isReachable(hostId)).toBe(true);

		// Accumulate failures
		for (let i = 0; i < 3; i++) {
			tracker.recordFailure(hostId);
			if (i < 2) {
				expect(tracker.isReachable(hostId)).toBe(true);
			}
		}

		// After 3 failures, marked unreachable
		expect(tracker.isReachable(hostId)).toBe(false);

		// Successful sync resets to reachable
		tracker.recordSuccess(hostId);
		expect(tracker.isReachable(hostId)).toBe(true);
		expect(tracker.getState(hostId)?.failureCount).toBe(0);
	});

	it("allows configuration of maxFailures threshold", () => {
		const tracker = new ReachabilityTracker(2);
		const hostId = "custom-threshold";

		tracker.recordFailure(hostId);
		expect(tracker.isReachable(hostId)).toBe(true);

		tracker.recordFailure(hostId);
		expect(tracker.isReachable(hostId)).toBe(false);
	});

	it("tracks multiple hosts independently", () => {
		const tracker = new ReachabilityTracker(2);

		// Host A: 2 failures → unreachable
		tracker.recordFailure("host-a");
		tracker.recordFailure("host-a");
		expect(tracker.isReachable("host-a")).toBe(false);

		// Host B: 1 failure → still reachable
		tracker.recordFailure("host-b");
		expect(tracker.isReachable("host-b")).toBe(true);

		// Host C: unknown → reachable
		expect(tracker.isReachable("host-c")).toBe(true);
	});

	it("returns undefined for getState on completely unknown host", () => {
		const tracker = new ReachabilityTracker();
		expect(tracker.getState("never-seen")).toBeUndefined();
	});
});
