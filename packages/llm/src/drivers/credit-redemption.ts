/**
 * Driver-level inline credit-redemption EXECUTOR (R-RT18,
 * 2026-11-21-model-routing.md §7.3 step 2).
 *
 * The pure planner (`planCreditRedemption`) decides whether a credited inline
 * retry is eligible and, if so, the ordered step-down. This executor walks that
 * plan on the inference host: it observes a driver's own stream, and when that
 * stream ends in a 200-shaped refusal carrying a provider `fallback_credit_token`
 * whose fallback target is co-located on this same endpoint, it replays the
 * refused prompt via a driver-supplied `runStep` callback — stepping down
 * continuation-body → unchanged-plus-token → drop-token (or expressing a
 * server-side fallback for `server_side_auto` drivers), stopping on the first
 * attempt that is not itself a refusal.
 *
 * It performs no HTTP and builds no wire body: the driver's `runStep` owns that,
 * so each provider keeps its own body adaptation (Mantle `reasoning.summary`
 * pinning, Bedrock envelope selection, …). The executor only sequences the plan
 * and enforces the invariants the spec attaches to redemption:
 *
 *  - identical beta flags and UNSTRIPPED thinking on every credited step (the
 *    `CreditStep` carries `preserveBetaFlags`/`stripThinking: false`, and the
 *    driver honors them when it builds the step body);
 *  - NEVER silently re-run billed server tools — surface the error instead;
 *  - a transient `"redemption temporarily unavailable"` error retries the SAME
 *    step with the SAME token inside the 5-minute window;
 *  - a non-co-located (or token-less) refusal flows straight through so the
 *    loop-host router owns the fallback.
 */

import { ConstantBackoff, handleWhen, retry } from "cockatiel";
import {
	type CreditRedemptionPlan,
	type CreditStep,
	isTransientRedemptionError,
	planCreditRedemption,
} from "../fallback-credit";
import type { DriverFallbackSupport } from "../fallback-policy";
import type { ModelDeclinedOutcome } from "../model-declined";
import type { StreamChunk } from "../types";

/** The co-located fallback target for a refusal, resolved by the driver. */
export interface CreditRedemptionTarget {
	/** Next fallback target logical model. */
	targetModel: string;
	/** Endpoint identity that serves `targetModel` on this host. */
	targetEndpoint: string;
}

/** Driver-supplied hooks the executor sequences a redemption plan against. */
export interface CreditRedemptionDriverConfig {
	/** This driver's static fallback-protocol descriptor. */
	driver: DriverFallbackSupport;
	/** Endpoint identity the executing driver is bound to this turn. */
	executingEndpoint: string;
	/**
	 * Resolve the next fallback target for a refusal, or null when there is no
	 * eligible target (empty chain). Only called when the refusal carries a
	 * credit token — a token-less refusal flows straight through untouched.
	 */
	resolveTarget: (outcome: ModelDeclinedOutcome) => CreditRedemptionTarget | null;
	/**
	 * Whether billed server tools ran in the refused attempt. When true, the
	 * executor surfaces an error rather than retrying uncredited (§7.3).
	 */
	serverToolsRan: (chunks: StreamChunk[]) => boolean;
	/**
	 * Replay the refused prompt for one step-down step, returning the step's
	 * stream. The driver builds the wire body for `step` (honoring
	 * `includeToken`, `preserveBetaFlags`, and `stripThinking: false`) against
	 * `target`, appending the refused assistant echo for a `continuation-body`
	 * step. `refusedChunks` is the full primary attempt for continuation echo.
	 */
	runStep: (
		step: CreditStep,
		target: CreditRedemptionTarget,
		refusedChunks: StreamChunk[],
	) => AsyncIterable<StreamChunk>;
}

/** Transient-redemption retries are bounded so a stuck provider can't hot-loop. */
const MAX_TRANSIENT_RETRIES = 3;

const transientRedemptionRetry = retry(
	handleWhen((err) => isTransientRedemptionError(err instanceof Error ? err.message : String(err))),
	// Each retry passes through a 0ms timer before re-running the step.
	{ maxAttempts: MAX_TRANSIENT_RETRIES, backoff: new ConstantBackoff(0) },
);

/** The classified refusal on a done chunk, or null when the stream finished clean. */
function refusalOf(chunks: StreamChunk[]): ModelDeclinedOutcome | null {
	for (let i = chunks.length - 1; i >= 0; i--) {
		const c = chunks[i];
		if (c?.type === "done") return c.declined ?? null;
	}
	return null;
}

/**
 * Observe `primary` (the driver's first attempt) and, on a co-located
 * credit-bearing refusal, walk the planned step-down via `config.runStep`.
 * Yields the primary stream's chunks through unchanged, then — if a redemption
 * is both planned and succeeds — the chunks of the step that served the turn.
 *
 * A clean finish, a token-less refusal, a non-co-located refusal, or an
 * exhausted step-down all leave the original stream as the terminal output; the
 * loop host then applies its own router-level fallback (or surfaces the refusal).
 */
export async function* redeemFallbackCredit(
	primary: AsyncIterable<StreamChunk>,
	config: CreditRedemptionDriverConfig,
): AsyncIterable<StreamChunk> {
	// Buffer the primary attempt: we need the full chunk list to classify the
	// refusal, decide server-tools-ran, and build a continuation echo. Yield as
	// we go so the caller still streams the primary attempt live.
	const primaryChunks: StreamChunk[] = [];
	for await (const chunk of primary) {
		primaryChunks.push(chunk);
		yield chunk;
	}

	const refusal = refusalOf(primaryChunks);
	// No refusal, or a refusal with no credit token: nothing to redeem inline.
	// The loop-host router owns any substitution from here.
	if (!refusal?.credit?.token) return;

	const target = config.resolveTarget(refusal);
	const plan = planCreditRedemption({
		driver: config.driver,
		outcome: refusal,
		targetModel: target?.targetModel ?? "",
		targetEndpoint: target?.targetEndpoint ?? "",
		executingEndpoint: config.executingEndpoint,
		serverToolsRan: config.serverToolsRan(primaryChunks),
	});

	if (!plan.eligible) {
		if (plan.surfaceError) {
			// Server tools already ran in the refused attempt: an uncredited retry
			// would re-run billed server tools, so surface the refusal as an error
			// rather than stepping down (§7.3).
			throw new ServerToolsRanRefusalError(refusal);
		}
		// driver-unsupported / no-token / not-co-located: forfeit the endpoint-bound
		// credit and leave the refusal in place for the loop-host router.
		return;
	}

	// Eligible: `resolveTarget` must have returned a target (the planner's
	// co-location check compared it), but guard defensively.
	if (!target) return;

	yield* walkStepDown(plan, target, primaryChunks, config);
}

/**
 * Walk the planned step-down. Each step runs via `config.runStep`; a step that
 * does not itself refuse serves the turn and stops the walk. A transient
 * redemption error retries the SAME step with the SAME token; any other error
 * propagates. When every step still refuses, the last step's (refusal) chunks
 * are the terminal output and the loop-host router takes over.
 */
async function* walkStepDown(
	plan: CreditRedemptionPlan,
	target: CreditRedemptionTarget,
	refusedChunks: StreamChunk[],
	config: CreditRedemptionDriverConfig,
): AsyncIterable<StreamChunk> {
	for (const step of plan.steps) {
		// A transient redemption error retries the SAME step with the same token
		// inside the 5-minute window (§7.3); any other error propagates.
		const stepChunks = await transientRedemptionRetry.execute(async () => {
			const chunks: StreamChunk[] = [];
			for await (const chunk of config.runStep(step, target, refusedChunks)) {
				chunks.push(chunk);
			}
			return chunks;
		});

		// Step completed. If it did not refuse, it served the turn: emit its
		// chunks (stamped with the serving model and whether the credit was
		// redeemed) and stop the walk.
		if (!refusalOf(stepChunks)) {
			yield* stampProvenance(stepChunks, target.targetModel, step.includeToken);
			return;
		}
		// Still a refusal: step down to the next planned step. Hold this step's
		// chunks as the terminal output in case the step-down exhausts. A refused
		// attempt redeemed nothing, whether or not it carried the token.
		if (step === plan.steps[plan.steps.length - 1]) {
			yield* stampProvenance(stepChunks, target.targetModel, false);
			return;
		}
	}
}

/** Stamp served-model provenance onto a step's `done` chunk(s). */
function stampProvenance(
	chunks: StreamChunk[],
	servedModel: string,
	creditRedeemed: boolean,
): StreamChunk[] {
	return chunks.map((chunk) =>
		chunk.type === "done"
			? { ...chunk, served_model: servedModel, credit_redeemed: creditRedeemed }
			: chunk,
	);
}

/**
 * Raised when a refusal carries a credit but billed server tools already ran in
 * the refused attempt. Surfacing this (rather than retrying uncredited) is the
 * §7.3 "never silently re-run billed server tools" rule.
 */
class ServerToolsRanRefusalError extends Error {
	constructor(public outcome: ModelDeclinedOutcome) {
		super(
			"Model refused after billed server tools ran; surfacing the refusal " +
				"instead of retrying uncredited (R-RT18, §7.3).",
		);
		this.name = "ServerToolsRanRefusalError";
	}
}
