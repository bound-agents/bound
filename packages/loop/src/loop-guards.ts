import type { ParsedToolCall } from "./stream-parser";

/**
 * Circuit breaker for consecutive truncated tool calls on the same tool name.
 * If the parser flags N turns in a row as truncated for the same tool, we abort
 * the loop rather than let it spin. Guards against parser bugs (e.g. an
 * empty-args false-truncation regression that burned 23M tokens
 * across 3,654 turns before a human cancelled manually).
 */
export const MAX_CONSECUTIVE_TRUNCATED_TURNS = 5;

/**
 * Circuit breaker for consecutive identical (non-truncated) tool calls. Unlike
 * the truncation breaker above — which fires on malformed/parser-flagged calls —
 * this fires on well-formed calls that repeat byte-for-byte turn after turn: the
 * signature of a model stuck re-issuing the same call and re-deciding without
 * acting on the result (observed as a synthesis spin — 20+ identical
 * delta-check queries over ~6 min that all PARSED CLEANLY, so the truncation
 * breaker never saw them). Keyed on tool name + raw args, so a sequence of
 * *distinct* calls (real progress) never trips it. The threshold is higher than
 * the truncation breaker's because legitimate polling (re-querying until
 * external state flips) is byte-identical-repeated and benign in short runs.
 */
export const MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS = 12;

/**
 * Circuit breaker for consecutive turns whose tool calls return the
 * byte-identical ERROR result. Distinct from MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS
 * above, which keys on the CALL inputs (name + args) and resets the moment the
 * model varies its args. A production spin on gpt-5.5 defeated the
 * input-signature breaker exactly that way: the model emitted ~26 calls under
 * the name "connector" with *different* skill/memory arg schemas each turn, so
 * the input signature kept resetting while every call returned the identical
 * Zod validation error (an enum error enumerates the *valid* options, not the
 * rejected value, so it is input-independent). The loop never broke — the
 * same error 26 times across ~4 minutes, two user cancels, no self-recovery.
 * This breaker keys on the
 * ERROR RESULT instead, and only counts turns where EVERY tool call errored
 * (a mixed turn means the model is getting *some* useful signal — not a spin).
 * It can only fire post-execution (the error isn't known until the tool runs),
 * unlike the two pre-execution breakers above.
 */
export const MAX_CONSECUTIVE_ERROR_TOOL_CALLS = 12;

/**
 * Before the hard abort at MAX_CONSECUTIVE_ERROR_TOOL_CALLS, inject a single
 * corrective developer nudge at this count — re-surfacing the repeated error as
 * an imperative directive (the model is evidently ignoring the identical
 * tool_result it sees every turn). The nudge fires once per error chain and
 * resets when the chain breaks, so a model that recovers never sees it again.
 */
export const ERROR_SIGNATURE_NUDGE_AT = 5;

/**
 * Hard abort for consecutive turns where every tool call errors with a
 * cross-tool routing suggestion. When the host can name the correct tool, the
 * model is not just stuck — it is ignoring explicit corrective guidance. This
 * fuse is intentionally short because the fix is already known and the model is
 * not recovering. The base loop only counts this chain when the host classifies
 * a result as a routing error (see classifyToolResultError); without a routing
 * classifier the chain never advances and this breaker is inert.
 */
export const MAX_CONSECUTIVE_ROUTING_ERROR_TOOL_CALLS = 3;

/** Tunable thresholds for the loop's tool-call circuit breakers. */
export interface LoopGuardThresholds {
	maxConsecutiveTruncatedTurns: number;
	maxConsecutiveDuplicateToolCalls: number;
	maxConsecutiveErrorToolCalls: number;
	errorSignatureNudgeAt: number;
	maxConsecutiveRoutingErrorToolCalls: number;
}

export const DEFAULT_LOOP_GUARD_THRESHOLDS: LoopGuardThresholds = {
	maxConsecutiveTruncatedTurns: MAX_CONSECUTIVE_TRUNCATED_TURNS,
	maxConsecutiveDuplicateToolCalls: MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS,
	maxConsecutiveErrorToolCalls: MAX_CONSECUTIVE_ERROR_TOOL_CALLS,
	errorSignatureNudgeAt: ERROR_SIGNATURE_NUDGE_AT,
	maxConsecutiveRoutingErrorToolCalls: MAX_CONSECUTIVE_ROUTING_ERROR_TOOL_CALLS,
};

/**
 * Excerpt a tool error for inclusion in a loop-guard nudge/abort notice. Keeps
 * the head (where validation errors enumerate the valid options) and caps the
 * length so a large error body can't bloat the developer message.
 */
export function truncateForNudge(content: string): string {
	const MAX = 400;
	const trimmed = content.trim();
	return trimmed.length <= MAX ? trimmed : `${trimmed.slice(0, MAX)}…`;
}

/**
 * Stable signature for a turn's tool calls, keyed on name + raw args. Used by
 * the duplicate-call breaker: two turns with the same signature are the model
 * re-issuing identical calls. NUL-joined so multi-call turns can't collide with
 * a single concatenated call.
 */
export function toolCallSignature(toolCalls: ParsedToolCall[]): string {
	return toolCalls
		.map((tc) => `${tc.name}:${tc.argsJson ?? JSON.stringify(tc.input)}`)
		.join("\u0000");
}

/**
 * Stable signature for a turn's tool *error* results, keyed on name + result
 * content. Returns null unless EVERY result in the turn errored — a mixed turn
 * means the model is getting some useful signal and is not spinning. Used by
 * the identical-error breaker. Control-char joins (NUL between name and content,
 * SOH between results) keep distinct result sets from colliding.
 */
export function toolErrorSignature(
	results: Array<{ toolCall: { name: string }; result: { content: string; exitCode: number } }>,
): string | null {
	if (results.length === 0 || !results.every((r) => r.result.exitCode !== 0)) {
		return null;
	}
	return results.map((r) => `${r.toolCall.name}\u0000${r.result.content}`).join("\u0001");
}
