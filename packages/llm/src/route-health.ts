/**
 * Per-host route health with half-open recovery (#285, spec §6.1, R-RT11–R-RT13).
 *
 * Route health is tracked per {@link RouteId} **locally per host** and is NOT
 * synced through `change_log` — it is short-lived failure state that would
 * otherwise flood replication (Invariant #3).
 *
 * The router indexes its backends by the local `backendId`, which maps 1:1 to a
 * `RouteId` via `routeIdentities`. This machine is therefore keyed by
 * `backendId` — the local addressing key — while modelling exactly the
 * per-`RouteId` health the spec describes.
 *
 * A route moves between three states (R-RT11):
 *
 * - `healthy`   — normal routing.
 * - `backoff`   — entered on any route failure. The wait is
 *                 `min(30s · 2^(n−1), 4h)`, or exactly the `Retry-After` value
 *                 when a `429` supplies one.
 * - `half_open` — entered automatically when the backoff window expires. Each
 *                 host lets at most one concurrent trial turn through, and that
 *                 trial must come from a new or cold-cache thread (never a warm
 *                 sticky thread). No synthetic probes are sent.
 *
 * The trial decides what happens next (R-RT12):
 *
 * - Success returns the route to `healthy`, which drops `consecutive_failures`.
 * - Failure doubles the backoff (capped at 4h) and the trial turn fails over to
 *   the next ranked route.
 */

/** Backoff floor: the first failure waits 30 seconds. */
export const BACKOFF_BASE_MS = 30_000;
/** Backoff ceiling: exponential growth is clamped here (4 hours). */
export const BACKOFF_CAP_MS = 4 * 60 * 60 * 1000;

/**
 * The classification of the failure that tripped (or kept) a route in backoff.
 * Carried on `backoff`/`half_open` so the router/loop can apply error-specific
 * handling (R-RT13) without re-inspecting the original error.
 */
export type RouteErrorKind =
	| "rate_limit" // 429 / 529 — backoff, or exact Retry-After when supplied
	| "auth" // 401 / 403 — token refresh attempted before backoff
	| "driver_bug" // sustained non-refusal 400s — single advisory, keep recovering
	| "server" // 5xx / 402
	| "transport" // network / TLS / DNS / relay timeout
	| "unknown";

/**
 * Local, per-host route health state (spec §6.1). Mirrors the spec's
 * `RouteHealthState` union exactly.
 */
export type RouteHealthState =
	| { status: "healthy" }
	| {
			status: "backoff";
			consecutive_failures: number;
			next_trial_at: number;
			last_error_kind: RouteErrorKind;
	  }
	| { status: "half_open"; trial_in_flight: boolean; consecutive_failures: number };

/**
 * Compute the backoff duration for the n-th consecutive failure:
 * `min(30s · 2^(n−1), 4h)`. `consecutiveFailures` is 1-based (the first failure
 * is `n = 1` → 30s).
 */
export function computeBackoffMs(consecutiveFailures: number): number {
	const n = Math.max(1, consecutiveFailures);
	// 2^(n-1) grows past Number.MAX_SAFE_INTEGER around n≈53; clamp the exponent
	// so the multiplication never overflows to Infinity before the cap applies.
	const exponent = Math.min(n - 1, 40);
	const raw = BACKOFF_BASE_MS * 2 ** exponent;
	return Math.min(raw, BACKOFF_CAP_MS);
}

/**
 * Per-host route-health registry. One instance lives on each `ModelRouter`.
 * Keyed by local `backendId` (1:1 with `RouteId`). All time reads go through the
 * injected `clock` so tests can drive transitions deterministically.
 */
export class RouteHealth {
	/** Explicit state only for routes that are not `healthy`. Absence = healthy. */
	private states = new Map<string, RouteHealthState>();

	constructor(private clock: () => number = Date.now) {}

	/**
	 * Returns the live state for a route, folding the automatic
	 * `backoff → half_open` transition at `now >= next_trial_at` (R-RT12). A
	 * route with no recorded state is `healthy`.
	 */
	getState(id: string): RouteHealthState {
		const state = this.states.get(id);
		if (!state) return { status: "healthy" };
		if (state.status === "backoff" && this.clock() >= state.next_trial_at) {
			const promoted: RouteHealthState = {
				status: "half_open",
				trial_in_flight: false,
				consecutive_failures: state.consecutive_failures,
			};
			this.states.set(id, promoted);
			return promoted;
		}
		return state;
	}

	/**
	 * Record a classified route failure (§7.1). Moves the route to `backoff`,
	 * incrementing `consecutive_failures` and applying `min(30s · 2^(n−1), 4h)` —
	 * or the exact `retryAfterMs` when the provider supplied one on a `429`.
	 *
	 * A failure arriving during a `half_open` trial also lands here: it doubles
	 * the backoff (via the incremented count) up to the cap, per R-RT12.
	 */
	recordFailure(id: string, opts: { errorKind: RouteErrorKind; retryAfterMs?: number }): void {
		const prior = this.getState(id);
		const priorFailures =
			prior.status === "backoff" || prior.status === "half_open" ? prior.consecutive_failures : 0;
		const consecutive_failures = priorFailures + 1;
		const now = this.clock();
		// Exact Retry-After wins only when the provider actually supplied one on a
		// rate-limit response; otherwise fall back to the exponential schedule.
		const waitMs =
			opts.errorKind === "rate_limit" && typeof opts.retryAfterMs === "number"
				? opts.retryAfterMs
				: computeBackoffMs(consecutive_failures);
		this.states.set(id, {
			status: "backoff",
			consecutive_failures,
			next_trial_at: now + waitMs,
			last_error_kind: opts.errorKind,
		});
	}

	/**
	 * Record a successful turn. A success on any non-healthy route (the
	 * half-open trial, or an in-flight turn that beats the window) restores
	 * `healthy`, which clears `consecutive_failures`.
	 */
	recordSuccess(id: string): void {
		this.states.delete(id);
	}

	/**
	 * Whether this host may send a half-open trial for `id` right now (R-RT12):
	 * the route must be `half_open`, no trial may already be in flight on this
	 * host, and the candidate thread must be new or cold-cache — never a warm
	 * sticky thread. Returns false for `healthy` (no trial needed) and `backoff`
	 * (window not yet expired).
	 */
	canTrial(id: string, opts: { coldOrNewThread: boolean }): boolean {
		const state = this.getState(id);
		if (state.status !== "half_open") return false;
		if (state.trial_in_flight) return false;
		return opts.coldOrNewThread;
	}

	/**
	 * Claim the single per-host trial slot for a half-open route. Returns true if
	 * the slot was free and is now held; false if a trial is already in flight or
	 * the route is not half-open. The caller must pair a successful claim with
	 * exactly one {@link recordSuccess} or {@link recordFailure}.
	 */
	beginTrial(id: string): boolean {
		const state = this.getState(id);
		if (state.status !== "half_open" || state.trial_in_flight) return false;
		this.states.set(id, { ...state, trial_in_flight: true });
		return true;
	}

	/**
	 * Whether a route is currently selectable for normal (non-trial) routing.
	 * `healthy` and `half_open` are selectable (half-open accepts a real trial
	 * turn); `backoff` is not.
	 */
	isAvailable(id: string): boolean {
		return this.getState(id).status !== "backoff";
	}

	/**
	 * Earliest `next_trial_at` (ms) among routes still in `backoff`, used to
	 * populate `earliestRecovery` on transient-unavailable errors. Returns null
	 * when no route is backing off. The optional filter lets the router restrict
	 * to capability-matching routes.
	 */
	earliestRecovery(filter?: (id: string) => boolean): number | null {
		let earliest: number | null = null;
		for (const [id, state] of this.states) {
			if (state.status !== "backoff") continue;
			if (filter && !filter(id)) continue;
			if (earliest === null || state.next_trial_at < earliest) {
				earliest = state.next_trial_at;
			}
		}
		return earliest;
	}

	/** Discard all health for a route (R-RT22: router rebuild / backend removal). */
	clear(id: string): void {
		this.states.delete(id);
	}

	/** Discard all health (router `reload`). */
	reset(): void {
		this.states.clear();
	}
}
