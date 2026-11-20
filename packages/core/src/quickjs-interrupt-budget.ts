import type { QuickJSRuntime } from "quickjs-emscripten-core";

/**
 * Fuel budget for a single QuickJS config/callback evaluation.
 *
 * The limit exists to bound a runaway or hung guest script — an infinite loop
 * must not wedge the host — NOT to assert a wall-clock performance budget. The
 * previous implementation armed the interrupt handler with a `Date.now()`
 * deadline (`Date.now() > deadline`). That is WALL-CLOCK time, and the wall
 * clock advances while the host process is descheduled: on a contended CI
 * runner (a ~2-core macOS lane mid test sweep) a config eval doing microseconds
 * of real guest work could be descheduled past a tight deadline and aborted
 * with "error: interrupted", failing startup (or silently falling back to
 * static pricing) on a healthy config. The failure was not reproducible
 * locally because it needs host contention, not guest work — a duration-based
 * guard is inherently flaky under descheduling.
 *
 * A fuel budget counts guest progress instead of host time. QuickJS polls the
 * interrupt handler at a bounded cadence while executing bytecode; each poll
 * decrements the budget, and the handler aborts only once the budget is
 * exhausted. Host descheduling cannot consume fuel, so a tiny static config
 * eval can never be aborted no matter how long the host is parked — while a
 * genuine unbounded loop still exhausts the finite budget and is interrupted.
 *
 * The default budget is sized from measurement, not guesswork: a QuickJS poll
 * covers many bytecode steps, so even a heavy legitimate config (a 50k-iteration
 * builder doing arithmetic + string work) consumes ~21 polls / ~17ms, while an
 * unbounded loop drains the budget at a measured ~36k polls/sec on this host.
 * 50,000 polls therefore leaves a legitimate config ~2000x of headroom while a
 * runaway loop is interrupted in roughly a second — bounded, host-independent,
 * and immune to descheduling (parked time consumes no fuel).
 */
export const DEFAULT_CONFIG_INTERRUPT_BUDGET = 50_000;

/**
 * Arm `runtime`'s interrupt handler with a fuel budget: the handler returns
 * `true` (aborting the running guest) after `budget` interrupt polls, and
 * `false` until then. Returns the runtime for chaining.
 *
 * Budget is per-evaluation: call this once per `runtime` right after creating
 * it, as a direct replacement for the `Date.now()`-deadline pattern.
 */
export function setInterruptBudget(
	runtime: QuickJSRuntime,
	budget: number = DEFAULT_CONFIG_INTERRUPT_BUDGET,
): QuickJSRuntime {
	let fuel = budget;
	runtime.setInterruptHandler(() => {
		fuel -= 1;
		return fuel <= 0;
	});
	return runtime;
}
