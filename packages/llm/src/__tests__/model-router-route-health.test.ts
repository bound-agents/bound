import { describe, expect, it } from "bun:test";
import { ModelRouter } from "../model-router";
import { BACKOFF_BASE_MS } from "../route-health";
import type { BackendCapabilities, LLMBackend } from "../types";

/**
 * Coverage for the #285 route-health methods the `ModelRouter` exposes over its
 * internal {@link RouteHealth} registry: the classified failure/success seams,
 * the half-open trial gate, the sticky-reuse predicate, the `isRateLimited`
 * predicate, and the capability-filtered recovery lookup. The registry itself is unit-tested in `route-health.test.ts`; this
 * file exercises the router wiring the loop actually calls.
 */

class MockBackend implements LLMBackend {
	constructor(
		public id: string,
		private caps?: Partial<BackendCapabilities>,
	) {}

	async *chat() {
		// Mock implementation — never invoked by these tests.
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			extended_thinking: false,
			max_context: 4096,
			...this.caps,
		};
	}
}

function routerWith(
	backends: Array<{ id: string; caps?: Partial<BackendCapabilities> }>,
	clock: () => number,
): ModelRouter {
	const map = new Map<string, LLMBackend>();
	const effectiveCaps = new Map<string, BackendCapabilities>();
	for (const { id, caps } of backends) {
		const backend = new MockBackend(id, caps);
		map.set(id, backend);
		effectiveCaps.set(id, backend.capabilities());
	}
	return new ModelRouter(map, backends[0].id, effectiveCaps, undefined, undefined, clock);
}

describe("ModelRouter route health — recordRouteFailure / isRateLimited (#285)", () => {
	it("a classified failure backs the route off and makes it unavailable", () => {
		const now = 1_000;
		const router = routerWith([{ id: "a" }], () => now);
		expect(router.isRateLimited("a")).toBe(false);
		expect(router.getRouteHealthState("a").status).toBe("healthy");

		router.recordRouteFailure("a", { errorKind: "server" });
		expect(router.isRateLimited("a")).toBe(true);
		const state = router.getRouteHealthState("a");
		expect(state.status).toBe("backoff");
	});

	it("a success on a backed-off route restores it to healthy", () => {
		const now = 1_000;
		const router = routerWith([{ id: "a" }], () => now);
		router.recordRouteFailure("a", { errorKind: "transport" });
		expect(router.isRateLimited("a")).toBe(true);

		router.recordRouteSuccess("a");
		expect(router.isRateLimited("a")).toBe(false);
		expect(router.getRouteHealthState("a").status).toBe("healthy");
	});
});

describe("ModelRouter route health — half-open trials (#285, R-RT12)", () => {
	it("canTrialRoute gates on half_open + cold/new thread and claims one slot per host", () => {
		let now = 1_000;
		const router = routerWith([{ id: "a" }], () => now);
		router.recordRouteFailure("a", { errorKind: "server" });

		// Still in backoff — no trial yet.
		expect(router.canTrialRoute("a", { coldOrNewThread: true })).toBe(false);

		// Advance past the backoff window → getState folds to half_open.
		now += BACKOFF_BASE_MS;
		expect(router.getRouteHealthState("a").status).toBe("half_open");

		// A warm sticky thread may not trial.
		expect(router.canTrialRoute("a", { coldOrNewThread: false })).toBe(false);
		// A cold/new thread may, and claiming takes the single slot.
		expect(router.canTrialRoute("a", { coldOrNewThread: true, claim: true })).toBe(true);
		// A second concurrent claim is refused.
		expect(router.canTrialRoute("a", { coldOrNewThread: true, claim: true })).toBe(false);
	});

	it("canTrialRoute without claim is a non-mutating probe", () => {
		let now = 1_000;
		const router = routerWith([{ id: "a" }], () => now);
		router.recordRouteFailure("a", { errorKind: "server" });
		now += BACKOFF_BASE_MS;
		expect(router.getRouteHealthState("a").status).toBe("half_open");
		// Probing repeatedly without claim never consumes the slot.
		expect(router.canTrialRoute("a", { coldOrNewThread: true })).toBe(true);
		expect(router.canTrialRoute("a", { coldOrNewThread: true })).toBe(true);
		// And a subsequent claim still succeeds.
		expect(router.canTrialRoute("a", { coldOrNewThread: true, claim: true })).toBe(true);
	});
});

describe("ModelRouter route health — isHealthyForSticky (#285, R-RT12)", () => {
	it("only a healthy route is reusable by a warm sticky thread", () => {
		let now = 1_000;
		const router = routerWith([{ id: "a" }], () => now);
		expect(router.isHealthyForSticky("a")).toBe(true);

		router.recordRouteFailure("a", { errorKind: "server" });
		// backoff → not sticky-reusable.
		expect(router.isHealthyForSticky("a")).toBe(false);

		now += BACKOFF_BASE_MS;
		// half_open → still not sticky-reusable (must be trialled by a new thread).
		expect(router.getRouteHealthState("a").status).toBe("half_open");
		expect(router.isHealthyForSticky("a")).toBe(false);

		router.recordRouteSuccess("a");
		expect(router.isHealthyForSticky("a")).toBe(true);
	});
});

describe("ModelRouter route health — getEarliestCapableRecovery (#285)", () => {
	it("returns the earliest trial time among capability-matching backing-off routes", () => {
		let now = 1_000;
		const router = routerWith(
			[
				{ id: "vision", caps: { vision: true } },
				{ id: "plain", caps: { vision: false } },
			],
			() => now,
		);
		// plain backs off first (earlier next_trial_at), vision second.
		router.recordRouteFailure("plain", { errorKind: "rate_limit", retryAfterMs: 30_000 }); // next_trial_at = 31_000
		now += 1;
		router.recordRouteFailure("vision", { errorKind: "rate_limit", retryAfterMs: 30_000 }); // next_trial_at = 31_001

		// No requirement: earliest overall is plain's.
		expect(router.getEarliestCapableRecovery()).toBe(31_000);
		// Require vision: plain is filtered out, so vision's time is returned.
		expect(router.getEarliestCapableRecovery({ vision: true })).toBe(31_001);
	});

	it("returns null when no capable route is backing off", () => {
		const now = 1_000;
		const router = routerWith([{ id: "a", caps: { vision: false } }], () => now);
		router.recordRouteFailure("a", { errorKind: "rate_limit", retryAfterMs: 30_000 });
		// The only backed-off route lacks vision → no capable recovery.
		expect(router.getEarliestCapableRecovery({ vision: true })).toBeNull();
	});
});

describe("ModelRouter route health — removeBackend clears health (#285, R-RT22)", () => {
	it("removing a backend discards its route health", () => {
		const now = 1_000;
		const router = routerWith([{ id: "a" }, { id: "b" }], () => now);
		router.recordRouteFailure("a", { errorKind: "server" });
		expect(router.isRateLimited("a")).toBe(true);

		router.removeBackend("a");
		// A re-added id with the same name starts healthy (no stale backoff).
		expect(router.getRouteHealthState("a").status).toBe("healthy");
	});
});
