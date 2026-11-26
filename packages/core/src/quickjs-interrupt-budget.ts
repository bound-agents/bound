import type { QuickJSRuntime } from "quickjs-emscripten-core";

/**
 * Fuel budget for a single QuickJS config/callback evaluation.
 *
 * The limit bounds a runaway or hung guest script — an infinite loop must not
 * wedge the host — not a wall-clock performance budget. A wall-clock deadline
 * advances while the host process is descheduled, so on a contended runner a
 * config eval doing microseconds of guest work can be aborted with
 * "error: interrupted" on a healthy config.
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
const DEFAULT_CONFIG_INTERRUPT_BUDGET = 50_000;

/** Budget is per-evaluation: call once per `runtime` right after creating it. */
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
