/**
 * Fallback-credit redemption planner (R-RT18, 2026-11-21-model-routing.md
 * §7.3 step 2, 2026-11-21-model-catalog.md §7.1).
 *
 * The PURE decision layer for the driver-level credited inline retry: given a
 * classified refusal carrying a provider `fallback_credit_token`, the active
 * driver's capability descriptor, the next fallback target, and where that
 * target is served relative to the executing endpoint, it decides:
 *
 *  1. whether the credited inline retry is eligible at all, and if not, why
 *     (driver-unsupported, no-token, not-co-located, server-tools-ran); and
 *  2. the ordered step-down attempt plan for an eligible redemption.
 *
 * It performs no HTTP. The executing driver walks `steps` in order, building
 * each step's wire body and sending it, moving to the next step on a validation
 * `400` and stopping on success. Branching is on `DriverFallbackSupport`, never
 * provider names (R-MC7).
 */

import type { DriverFallbackSupport } from "./fallback-policy";
import type { ModelDeclinedOutcome } from "./model-declined";

/** Why a credited inline retry is not planned (eligible === false). */
export type CreditIneligibleReason =
	"driver-unsupported" | "no-token" | "not-co-located" | "server-tools-ran";

/**
 * One step in the credited step-down (§7.3 step 2, "Redemption step-down").
 *
 * - `continuation-body`: append the refused response's echoed assistant content
 *   (trimming trailing whitespace and unmatched client `tool_use`) and send with
 *   the token. Planned only when `has_prefill_claim` is `true` or absent.
 * - `unchanged-plus-token`: resend the unchanged refused prompt body plus the token.
 * - `drop-token`: forfeit the credit and resend without the token.
 * - `server-side-fallback`: for a `server_side_auto` driver (Anthropic), express
 *   the fallback server-side (`fallbacks: "default"` / named) rather than replaying.
 */
export type CreditStepKind =
	"continuation-body" | "unchanged-plus-token" | "drop-token" | "server-side-fallback";

export interface CreditStep {
	kind: CreditStepKind;
	/** Whether this step carries `fallback_credit_token` on the wire. */
	includeToken: boolean;
	/**
	 * Credited steps NEVER strip earlier `thinking` / `redacted_thinking` blocks
	 * (§7.3 — "Earlier thinking blocks are not stripped on a credited retry").
	 */
	stripThinking: boolean;
	/**
	 * Credited steps resend the identical beta flags as the refused attempt
	 * (`fallback-credit-2026-07-01` plus whatever the original carried).
	 */
	preserveBetaFlags: boolean;
}

export interface CreditRedemptionContext {
	/** Active route's driver capability descriptor. */
	driver: DriverFallbackSupport;
	/** The classified refusal (carries `credit` when the provider minted a token). */
	outcome: ModelDeclinedOutcome;
	/** Next fallback target logical model (already resolved by the policy layer). */
	targetModel: string;
	/** Endpoint identity that serves `targetModel` on the executing host. */
	targetEndpoint: string;
	/** Endpoint identity the executing driver is bound to this turn. */
	executingEndpoint: string;
	/**
	 * Whether billed server tools already ran in the refused attempt. When true,
	 * an uncredited retry is forbidden — surface the error instead (§7.3,
	 * "unless server tools already ran in the refused attempt").
	 */
	serverToolsRan: boolean;
}

export interface CreditRedemptionPlan {
	/** Whether a credited inline retry is planned on this endpoint. */
	eligible: boolean;
	/** Set when `eligible === false`; the specific disqualifier. */
	reason?: CreditIneligibleReason;
	/**
	 * When `true`, the caller must surface the refusal as an error rather than
	 * fall back uncredited (server tools already ran). Only set with
	 * `reason === "server-tools-ran"`.
	 */
	surfaceError?: boolean;
	/**
	 * `true` for a `server_side_auto` driver that expresses the fallback
	 * server-side; `steps` then holds a single `server-side-fallback` step.
	 */
	serverSide?: boolean;
	/** Ordered step-down plan; empty when `eligible === false`. */
	steps: CreditStep[];
}

const INELIGIBLE = (
	reason: CreditIneligibleReason,
	surfaceError = false,
): CreditRedemptionPlan => ({
	eligible: false,
	reason,
	...(surfaceError ? { surfaceError: true } : {}),
	steps: [],
});

/**
 * Plan the credited inline retry step-down for a refusal, or explain why it is
 * ineligible. Eligibility gates, in order:
 *
 *  1. driver must declare `supports_fallback_credit`;
 *  2. the refusal must carry a `credit.token`;
 *  3. billed server tools must NOT have run (else surface the error);
 *  4. the target must be co-located on the executing endpoint.
 */
export function planCreditRedemption(ctx: CreditRedemptionContext): CreditRedemptionPlan {
	if (!ctx.driver.supports_fallback_credit) return INELIGIBLE("driver-unsupported");

	const credit = ctx.outcome.credit;
	if (!credit?.token) return INELIGIBLE("no-token");

	// Server tools already ran: an uncredited retry would re-run billed server
	// tools, so surface the error instead of stepping down at all.
	if (ctx.serverToolsRan) return INELIGIBLE("server-tools-ran", true);

	// Endpoint-bound credit is only redeemable on the endpoint that minted it.
	if (ctx.targetEndpoint !== ctx.executingEndpoint) return INELIGIBLE("not-co-located");

	// Server-side-auto drivers (Anthropic) express the fallback server-side
	// rather than replaying a Bedrock-style step-down body.
	if (ctx.driver.server_side_auto) {
		return {
			eligible: true,
			serverSide: true,
			steps: [
				{
					kind: "server-side-fallback",
					includeToken: true,
					stripThinking: false,
					preserveBetaFlags: true,
				},
			],
		};
	}

	// Bedrock Runtime / Mantle replay step-down. `has_prefill_claim === false`
	// means the provider says there is no prefill to continue from, so skip the
	// continuation-body step and start at the unchanged body + token. A `true`
	// or absent (Bedrock omits it) claim tries the continuation body first.
	const steps: CreditStep[] = [];
	if (credit.has_prefill_claim !== false) {
		steps.push({
			kind: "continuation-body",
			includeToken: true,
			stripThinking: false,
			preserveBetaFlags: true,
		});
	}
	steps.push({
		kind: "unchanged-plus-token",
		includeToken: true,
		stripThinking: false,
		preserveBetaFlags: true,
	});
	// Final forfeit: drop the token and retry uncredited. Safe here because
	// server tools did NOT run (gated above).
	steps.push({
		kind: "drop-token",
		includeToken: false,
		stripThinking: false,
		preserveBetaFlags: true,
	});

	return { eligible: true, steps };
}

/** Transient redemption errors retry with the same token inside the 5-minute window. */
const TRANSIENT_REDEMPTION_RE = /redemption temporarily unavailable/i;

/**
 * A `"redemption temporarily unavailable"` error is transient: the executing
 * driver retries with the same token within the 5-minute window rather than
 * stepping down. Any other redemption error (e.g. an invalid/expired token) is
 * terminal for that step and triggers the step-down.
 */
export function isTransientRedemptionError(message: string): boolean {
	return TRANSIENT_REDEMPTION_RE.test(message);
}
