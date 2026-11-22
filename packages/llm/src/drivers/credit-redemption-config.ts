/**
 * Shared driver glue for inline credit redemption (slice 5, R-RT18, §7.3).
 *
 * The executor (`redeemFallbackCredit`) needs two per-turn inputs each
 * credit-capable driver computes the same way: the next fallback target from
 * the turn's resolved chain (`ChatParams.fallback_models`), and whether billed
 * server tools ran in the refused attempt. Centralizing them here keeps each
 * driver's wiring down to its provider-specific `runStep` body builder.
 */

import type { ChatParams, StreamChunk } from "../types";
import type { CreditRedemptionTarget } from "./credit-redemption";

/**
 * Resolve the next fallback target for a credited retry from the turn's
 * resolved chain. The loop host ships `fallback_models` already ordered and
 * capability-filtered (R-RT18); the driver takes the first entry and treats it
 * as served on its own executing endpoint. `planCreditRedemption` then compares
 * that endpoint to the credit's minting endpoint for the co-location gate.
 *
 * Returns null when there is no chain (`never` policy, or an empty/absent list),
 * so the executor forfeits the credit to the loop-host router.
 */
export function resolveFallbackTargetFromParams(
	params: ChatParams,
	executingEndpoint: string,
): CreditRedemptionTarget | null {
	if (params.fallback_policy?.mode === "never") return null;
	const next = params.fallback_models?.[0];
	if (!next) return null;
	return { targetModel: next, targetEndpoint: executingEndpoint };
}

/**
 * Whether billed server tools ran in the refused attempt. A `tool_use_start`
 * chunk in the refused stream means the model already invoked a tool (including
 * a provider server-side tool such as web search), so an uncredited retry would
 * re-run billed work — the executor surfaces the refusal as an error instead of
 * stepping down (§7.3, "never quietly re-run billed server tools").
 */
export function serverToolsRanInChunks(chunks: StreamChunk[]): boolean {
	return chunks.some((c) => c.type === "tool_use_start");
}

/**
 * Extract the `fallback_credit_token` from a refused attempt's done chunk, or an
 * empty string when none is present. The driver's `runStep` replays the refused
 * prompt with this token on the credited steps (R-RT18).
 */
export function creditTokenOf(chunks: StreamChunk[]): string {
	for (let i = chunks.length - 1; i >= 0; i--) {
		const c = chunks[i];
		if (c?.type === "done") return c.declined?.credit?.token ?? "";
	}
	return "";
}
