import { describe, expect, it } from "bun:test";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, RouteHealth, computeBackoffMs } from "../route-health";

describe("computeBackoffMs (R-RT11)", () => {
	it("starts at 30s for the first failure and doubles each consecutive failure", () => {
		expect(computeBackoffMs(1)).toBe(BACKOFF_BASE_MS); // 30s
		expect(computeBackoffMs(2)).toBe(60_000); // 1m
		expect(computeBackoffMs(3)).toBe(120_000); // 2m
		expect(computeBackoffMs(4)).toBe(240_000); // 4m
	});

	it("caps backoff growth at 4h no matter how many failures accrue", () => {
		// 30s * 2^(n-1) first exceeds 4h at n=10 (30s*512=4.26h).
		expect(computeBackoffMs(10)).toBe(BACKOFF_CAP_MS);
		expect(computeBackoffMs(50)).toBe(BACKOFF_CAP_MS);
		// No overflow to Infinity for absurd counts.
		expect(computeBackoffMs(1_000)).toBe(BACKOFF_CAP_MS);
	});

	it("treats 0 or negative counts as the first failure", () => {
		expect(computeBackoffMs(0)).toBe(BACKOFF_BASE_MS);
		expect(computeBackoffMs(-5)).toBe(BACKOFF_BASE_MS);
	});
});

describe("RouteHealth states (R-RT11)", () => {
	it("an unseen route is healthy", () => {
		const h = new RouteHealth();
		expect(h.getState("r").status).toBe("healthy");
		expect(h.isAvailable("r")).toBe(true);
	});

	it("any route failure moves the route to backoff with 30s wait on the first failure", () => {
		const now = 1_000_000;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" });
		const s = h.getState("r");
		expect(s.status).toBe("backoff");
		if (s.status === "backoff") {
			expect(s.consecutive_failures).toBe(1);
			expect(s.next_trial_at).toBe(now + BACKOFF_BASE_MS);
			expect(s.last_error_kind).toBe("server");
		}
		expect(h.isAvailable("r")).toBe(false);
	});

	it("consecutive failures double the backoff window", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "transport" }); // n=1 → 30s
		now += BACKOFF_BASE_MS; // expire, promote to half_open on read
		expect(h.getState("r").status).toBe("half_open");
		h.recordFailure("r", { errorKind: "transport" }); // n=2 → 60s
		const s = h.getState("r");
		expect(s.status).toBe("backoff");
		if (s.status === "backoff") {
			expect(s.consecutive_failures).toBe(2);
			expect(s.next_trial_at).toBe(now + 60_000);
		}
	});

	it("429 with an exact Retry-After uses that duration verbatim, not the exponential schedule", () => {
		const now = 500;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "rate_limit", retryAfterMs: 7_000 });
		const s = h.getState("r");
		expect(s.status).toBe("backoff");
		if (s.status === "backoff") {
			expect(s.next_trial_at).toBe(now + 7_000);
			expect(s.last_error_kind).toBe("rate_limit");
		}
	});

	it("a rate_limit failure without a Retry-After falls back to the exponential schedule", () => {
		const now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "rate_limit" });
		const s = h.getState("r");
		if (s.status === "backoff") expect(s.next_trial_at).toBe(now + BACKOFF_BASE_MS);
	});
});

describe("half-open transition and trials (R-RT12)", () => {
	it("a route in backoff moves to half_open when the backoff window expires [Done-when #1]", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" });
		expect(h.getState("r").status).toBe("backoff");
		now += BACKOFF_BASE_MS - 1;
		expect(h.getState("r").status).toBe("backoff"); // not yet
		now += 1; // now === next_trial_at
		expect(h.getState("r").status).toBe("half_open");
	});

	it("one successful real turn brings a route back to healthy [Done-when #2]", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" });
		now += BACKOFF_BASE_MS;
		expect(h.getState("r").status).toBe("half_open");
		expect(h.beginTrial("r")).toBe(true);
		h.recordSuccess("r");
		expect(h.getState("r").status).toBe("healthy");
	});

	it("repeated failures stop growing the backoff at 4h [Done-when #3]", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		// Drive ~15 failures, each time expiring the window so the next failure
		// increments consecutive_failures.
		for (let i = 0; i < 15; i++) {
			h.recordFailure("r", { errorKind: "server" });
			const s = h.getState("r");
			if (s.status === "backoff") now = s.next_trial_at;
		}
		h.recordFailure("r", { errorKind: "server" });
		const s = h.getState("r");
		expect(s.status).toBe("backoff");
		if (s.status === "backoff") {
			expect(s.next_trial_at - now).toBe(BACKOFF_CAP_MS);
		}
	});

	it("a warm sticky thread is never used as a trial; only a new/cold-cache thread is [Done-when #4]", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" });
		now += BACKOFF_BASE_MS; // half_open
		expect(h.canTrial("r", { coldOrNewThread: false })).toBe(false); // warm sticky → no trial
		expect(h.canTrial("r", { coldOrNewThread: true })).toBe(true); // new/cold → eligible
	});

	it("allows at most one concurrent trial per host", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" });
		now += BACKOFF_BASE_MS;
		expect(h.beginTrial("r")).toBe(true); // slot claimed
		expect(h.canTrial("r", { coldOrNewThread: true })).toBe(false); // in flight
		expect(h.beginTrial("r")).toBe(false); // second claim refused
	});

	it("a trial failure re-enters backoff with a doubled window and leaves the route unavailable", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" }); // n=1 → 30s
		now += BACKOFF_BASE_MS; // half_open
		expect(h.beginTrial("r")).toBe(true);
		h.recordFailure("r", { errorKind: "server" }); // trial fails → n=2 → 60s
		const s = h.getState("r");
		expect(s.status).toBe("backoff");
		if (s.status === "backoff") {
			expect(s.consecutive_failures).toBe(2);
			expect(s.next_trial_at).toBe(now + 60_000);
		}
		expect(h.isAvailable("r")).toBe(false);
	});

	it("half_open is selectable for a real trial turn (isAvailable true)", () => {
		let now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("r", { errorKind: "server" });
		now += BACKOFF_BASE_MS;
		expect(h.getState("r").status).toBe("half_open");
		expect(h.isAvailable("r")).toBe(true);
	});

	it("canTrial is false for healthy and backoff routes", () => {
		const now = 0;
		const h = new RouteHealth(() => now);
		expect(h.canTrial("healthy-route", { coldOrNewThread: true })).toBe(false);
		h.recordFailure("r", { errorKind: "server" });
		expect(h.canTrial("r", { coldOrNewThread: true })).toBe(false); // still in backoff
	});
});

describe("earliestRecovery", () => {
	it("returns the earliest next_trial_at among backing-off routes", () => {
		const now = 1_000;
		const h = new RouteHealth(() => now);
		h.recordFailure("a", { errorKind: "rate_limit", retryAfterMs: 100_000 });
		h.recordFailure("b", { errorKind: "rate_limit", retryAfterMs: 50_000 });
		expect(h.earliestRecovery()).toBe(now + 50_000);
	});

	it("honors a capability filter", () => {
		const now = 0;
		const h = new RouteHealth(() => now);
		h.recordFailure("a", { errorKind: "rate_limit", retryAfterMs: 10_000 });
		h.recordFailure("b", { errorKind: "rate_limit", retryAfterMs: 50_000 });
		expect(h.earliestRecovery((id) => id === "b")).toBe(now + 50_000);
	});

	it("returns null when no route is backing off", () => {
		const h = new RouteHealth();
		expect(h.earliestRecovery()).toBeNull();
		// half_open routes are excluded from earliestRecovery.
		let now = 0;
		const h2 = new RouteHealth(() => now);
		h2.recordFailure("r", { errorKind: "server" });
		now += BACKOFF_BASE_MS;
		h2.getState("r"); // promote to half_open
		expect(h2.earliestRecovery()).toBeNull();
	});
});

describe("clear and reset (R-RT22)", () => {
	it("clear discards a single route's health", () => {
		const h = new RouteHealth();
		h.recordFailure("r", { errorKind: "server" });
		h.clear("r");
		expect(h.getState("r").status).toBe("healthy");
	});

	it("reset discards all health", () => {
		const h = new RouteHealth();
		h.recordFailure("a", { errorKind: "server" });
		h.recordFailure("b", { errorKind: "server" });
		h.reset();
		expect(h.getState("a").status).toBe("healthy");
		expect(h.getState("b").status).toBe("healthy");
	});
});
