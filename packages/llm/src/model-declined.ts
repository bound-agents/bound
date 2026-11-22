/**
 * Model-refusal classification (`2026-11-21-model-routing.md` §7.2, R-RT15).
 *
 * A model refusal means the request reached the model and a safety/policy
 * classifier declined it — distinct from a route failure (transport fault,
 * rate limit, server error, malformed request). Each provider signals a
 * refusal differently and over a different HTTP status: Anthropic/Bedrock and
 * OpenAI/Gemini `generateContent` refusals arrive as HTTP 200 with a terminal
 * stop reason, while the Gemini Interactions API surfaces a block as HTTP 400.
 *
 * These helpers normalize each vendor's native signal into one structured
 * `ModelDeclinedOutcome` **before** router error handling runs, so a refusal
 * never trips same-model route failover and never marks a route unhealthy. A
 * 400 that is NOT a recognized safety block falls through to route failure.
 */

import { LLMError, type LLMFinishReason } from "./types";

/**
 * A normalized model refusal. `category` is display/telemetry metadata, never
 * parsed for control flow beyond the `substitutable` flag the driver already
 * resolved. `credit`, when present, carries the provider's fallback-credit
 * token for the §7.3 driver-level redemption path (slice 1 classifies and
 * carries it; redemption lands in a later slice).
 */
export type ModelDeclinedOutcome = {
	kind: "model-declined";
	vendor: "anthropic" | "openai" | "google" | "other";
	/**
	 * Provider refusal category when available (e.g. "cyber", "bio",
	 * "reasoning_extraction", "SAFETY", "PROHIBITED_CONTENT"), else `null`.
	 */
	category: string | null;
	/** Provider-native finish_reason / stop_reason / error code. */
	raw_reason: string;
	/** Display-only text; never parsed for control flow. */
	explanation?: string;
	/** `false` for prompt-fixable categories such as `reasoning_extraction`. */
	substitutable: boolean;
	credit?: {
		token: string;
		/** `undefined` when omitted by Bedrock; triggers the step-down shape. */
		has_prefill_claim?: boolean;
		/** Endpoint identity that minted the token. */
		endpoint: string;
	};
};

/**
 * A classified refusal raised through the error path. Drivers that discover a
 * refusal in an HTTP error (notably the Gemini Interactions API 400) throw
 * this so `PooledBackend` and the router can see a refusal is NOT a route
 * failure — it propagates immediately rather than backing off the route and
 * retrying the same model on another pool entry.
 */
export class LLMRefusalError extends LLMError {
	constructor(
		message: string,
		provider: string,
		public outcome: ModelDeclinedOutcome,
		statusCode?: number,
		originalError?: Error,
	) {
		super(message, provider, statusCode, originalError);
		this.name = "LLMRefusalError";
	}
}

/** Anthropic `stop_details`, as surfaced on an HTTP 200 refusal stop. */
export interface AnthropicStopDetails {
	category?: string | null;
	explanation?: string;
	fallback_credit_token?: string;
	fallback_has_prefill_claim?: boolean;
}

/**
 * Anthropic / Bedrock: `stop_reason: "refusal"` plus `stop_details`. A
 * `reasoning_extraction` category is non-substitutable (prompt-fixable);
 * everything else is substitutable. `endpoint` identifies the deployment that
 * minted any `fallback_credit_token`, so a later co-location check can decide
 * whether an endpoint-bound credit is redeemable inline.
 */
export function classifyAnthropicRefusal(
	stopReason: string | null | undefined,
	stopDetails: AnthropicStopDetails | undefined,
	endpoint?: string,
): ModelDeclinedOutcome | null {
	if (stopReason !== "refusal") return null;
	const category = stopDetails?.category ?? null;
	const outcome: ModelDeclinedOutcome = {
		kind: "model-declined",
		vendor: "anthropic",
		category,
		raw_reason: "refusal",
		substitutable: category !== "reasoning_extraction",
	};
	if (stopDetails?.explanation !== undefined) outcome.explanation = stopDetails.explanation;
	if (stopDetails?.fallback_credit_token !== undefined) {
		outcome.credit = {
			token: stopDetails.fallback_credit_token,
			endpoint: endpoint ?? "",
		};
		if (stopDetails.fallback_has_prefill_claim !== undefined) {
			outcome.credit.has_prefill_claim = stopDetails.fallback_has_prefill_claim;
		}
	}
	return outcome;
}

/** OpenAI refusal signals across the Chat Completions and Responses APIs. */
export interface OpenAIRefusalSignals {
	/** `message.refusal` string or refusal content-part text. */
	messageRefusal?: string | null;
	/** Chat Completions `finish_reason`. */
	chatFinishReason?: string | null;
	/** Responses API `status`. */
	responsesStatus?: string | null;
	/** Responses API `incomplete_details.reason`. */
	responsesIncompleteReason?: string | null;
}

/**
 * OpenAI (Chat Completions & Responses): a `message.refusal` string/content
 * part, Chat `finish_reason: "content_filter"`, or Responses
 * `status: "incomplete"` with `incomplete_details.reason: "content_filter"`.
 * All OpenAI refusals are substitutable.
 */
export function classifyOpenAIRefusal(signals: OpenAIRefusalSignals): ModelDeclinedOutcome | null {
	if (signals.messageRefusal) {
		return {
			kind: "model-declined",
			vendor: "openai",
			category: null,
			raw_reason: "refusal",
			explanation: signals.messageRefusal,
			substitutable: true,
		};
	}
	if (signals.chatFinishReason === "content_filter") {
		return {
			kind: "model-declined",
			vendor: "openai",
			category: null,
			raw_reason: "content_filter",
			substitutable: true,
		};
	}
	if (
		signals.responsesStatus === "incomplete" &&
		signals.responsesIncompleteReason === "content_filter"
	) {
		return {
			kind: "model-declined",
			vendor: "openai",
			category: null,
			raw_reason: "content_filter",
			substitutable: true,
		};
	}
	return null;
}

/** Gemini `generateContent` terminal finish reasons that denote a safety block. */
const GEMINI_REFUSAL_FINISH_REASONS = new Set([
	"SAFETY",
	"PROHIBITED_CONTENT",
	"RECITATION",
	"SPII",
	"BLOCKLIST",
	"OTHER",
]);

/** Gemini `generateContent` refusal signals. */
export interface GeminiGenerateContentSignals {
	/** `promptFeedback.blockReason`. */
	promptBlockReason?: string | null;
	/** Candidate `finishReason`. */
	finishReason?: string | null;
}

/**
 * Gemini `generateContent`: a `promptFeedback.blockReason`, or a
 * `finishReason` in {SAFETY, PROHIBITED_CONTENT, RECITATION, SPII, BLOCKLIST,
 * OTHER}. All map to a substitutable refusal; the category is the raw reason.
 */
export function classifyGeminiGenerateContent(
	signals: GeminiGenerateContentSignals,
): ModelDeclinedOutcome | null {
	if (signals.promptBlockReason) {
		return {
			kind: "model-declined",
			vendor: "google",
			category: signals.promptBlockReason,
			raw_reason: signals.promptBlockReason,
			substitutable: true,
		};
	}
	if (signals.finishReason && GEMINI_REFUSAL_FINISH_REASONS.has(signals.finishReason)) {
		return {
			kind: "model-declined",
			vendor: "google",
			category: signals.finishReason,
			raw_reason: signals.finishReason,
			substitutable: true,
		};
	}
	return null;
}

/** Gemini Interactions API HTTP 400 `code` values that denote a safety block. */
const GEMINI_INTERACTIONS_SAFETY_CODES = new Set([
	"safety",
	"jailbreak",
	"prohibited_content",
	"blocklist",
]);

/**
 * Gemini Interactions API: an HTTP 400 whose error `code` is a recognized
 * safety block ({safety, jailbreak, prohibited_content, blocklist}) is a
 * refusal, not a route failure. Any other 400 code returns `null`, so the
 * caller leaves it on the route-failure path (R-RT15).
 */
export function classifyGeminiInteractions400(
	code: string | null | undefined,
): ModelDeclinedOutcome | null {
	if (!code || !GEMINI_INTERACTIONS_SAFETY_CODES.has(code)) return null;
	return {
		kind: "model-declined",
		vendor: "google",
		category: code,
		raw_reason: code,
		substitutable: true,
	};
}

/**
 * GitHub Copilot surfaces only the AI SDK's collapsed
 * `finishReason: "content-filter"`, with no provider-native category. Map that
 * to a substitutable refusal with `category: null`.
 */
export function classifyCopilotFinishReason(
	finishReason: LLMFinishReason | string | null | undefined,
): ModelDeclinedOutcome | null {
	if (finishReason !== "content-filter") return null;
	return {
		kind: "model-declined",
		vendor: "other",
		category: null,
		raw_reason: "content-filter",
		substitutable: true,
	};
}
