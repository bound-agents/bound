/**
 * Conversation-level branded types for Bedrock Converse requests.
 *
 * The element-level types (UserMessage, AssistantMessage) live in ./schemas
 * as zod-inferred types. This module adds the conversation-level invariants:
 *
 *   1. Starts with a user message
 *   2. Ends with a user message
 *   3. Strict role alternation (no consecutive same-role messages)
 *
 * These are encoded two ways:
 *
 *   (a) A recursive conditional type `StaticAlternating<T>` that enforces the
 *       invariants on tuple types. Useful for hand-written test fixtures and
 *       any in-code conversation builder where the shape is known statically.
 *       Capped at depth 50 — beyond that, the brand alone carries the
 *       guarantee and the runtime validator is the proof.
 *
 *   (b) A phantom-branded array type `BedrockValidatedConversation` that any
 *       dynamically-constructed conversation receives after passing through
 *       `validateBedrockRequest`. The brand means the array *has been* checked;
 *       downstream consumers can trust it without re-checking.
 *
 * The airlock: the ONLY way to produce a `BedrockValidatedConversation` is via
 * the validator. The ONLY way to call the Bedrock client's ConverseStream in
 * our code is with a `BedrockValidatedRequest`, which embeds a validated
 * conversation. Any refactor that tries to skip the validator fails to compile.
 */

import type { Branded } from "./brand";
import type {
	AssistantMessage,
	InferenceConfig,
	PerformanceConfig,
	SystemBlock,
	ToolName,
	UserMessage,
	ValidatedMessage,
} from "./schemas";

// ─── Depth-counter plumbing for the recursive type ──────────────────────────

/**
 * Decrement a number literal by one, up to 50. TS doesn't have arithmetic on
 * number literals, so we build a lookup tuple. Beyond 50 we return `never`
 * which the recursive type interprets as "give up and fall back to the
 * non-tuple form".
 */
type Prev = [
	never,
	0,
	1,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	12,
	13,
	14,
	15,
	16,
	17,
	18,
	19,
	20,
	21,
	22,
	23,
	24,
	25,
	26,
	27,
	28,
	29,
	30,
	31,
	32,
	33,
	34,
	35,
	36,
	37,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
	45,
	46,
	47,
	48,
	49,
	50,
];

// ─── Statically-alternating tuple type ──────────────────────────────────────

/**
 * Recursive conditional type that enforces strict role alternation on a tuple.
 *
 * - Single message: must be a UserMessage.
 * - Two or more: head and next must be different roles; recurse on the tail.
 * - Beyond `Depth` levels of recursion: stop recursing and accept `ValidatedMessage[]`
 *   for the tail. The brand still carries the conversation-level guarantee.
 *
 * This is primarily useful for hand-written test fixtures and any in-code
 * conversation builder where the literal tuple shape flows through. For the
 * common dynamic-construction case, the brand is what carries the proof.
 */
export type StaticAlternating<
	T extends readonly ValidatedMessage[],
	Depth extends number = 50,
> = Depth extends 0
	? T extends readonly ValidatedMessage[]
		? T
		: never
	: T extends readonly [infer Head extends ValidatedMessage]
		? Head extends UserMessage
			? readonly [Head]
			: never
		: T extends readonly [
					infer Head extends ValidatedMessage,
					infer Next extends ValidatedMessage,
					...infer Rest extends ValidatedMessage[],
				]
			? Head["role"] extends Next["role"]
				? never
				: readonly [Head, ...StaticAlternating<readonly [Next, ...Rest], Prev[Depth]>]
			: never;

// ─── Conversation-level brand ───────────────────────────────────────────────

/**
 * A messages array that has passed `validateBedrockRequest`. The brand means:
 *
 *   - starts with user
 *   - ends with user
 *   - alternates strictly
 *   - every message's content is non-empty and role-appropriate
 *   - every toolResult's toolUseId matches a toolUse in the preceding assistant turn
 *
 * None of these are checked structurally at the type level on this alias —
 * the brand is a promise. The promise is kept by the validator being the only
 * path that produces this type.
 */
export type BedrockValidatedConversation = Branded<
	readonly ValidatedMessage[],
	"BedrockValidatedConversation"
>;

/**
 * Helper for constructing a statically-alternating conversation from a literal
 * tuple. This is what test fixtures and in-code builders use when they want
 * compile-time proof of alternation before handing the conversation to the
 * driver.
 *
 * Example:
 *   const conv = staticConversation([
 *     { role: "user", content: [{ text: "hi" }] },
 *     { role: "assistant", content: [{ text: "hello" }] },
 *     { role: "user", content: [{ text: "how are you" }] },
 *   ] as const);
 *   // conv's type includes StaticAlternating; a misordered literal won't compile.
 *
 * The function still runs the runtime validator — compile-time proof of
 * alternation doesn't prove that, e.g., toolResult IDs match toolUse IDs, so
 * the runtime check is still mandatory.
 */
export type StaticConversationInput<T extends readonly ValidatedMessage[]> = StaticAlternating<T>;

// ─── Request-level brand ────────────────────────────────────────────────────

/**
 * A fully-validated Bedrock ConverseStream request. Embeds a validated
 * conversation plus system blocks, inference config, and tools.
 *
 * The driver accepts ONLY this type when building the ConverseStreamCommand.
 * That's the airlock.
 */
export interface BedrockValidatedRequest {
	readonly modelId: string;
	readonly messages: BedrockValidatedConversation;
	readonly system?: readonly SystemBlock[];
	readonly inferenceConfig: InferenceConfig;
	/**
	 * Performance configuration — only present when inferenceConfig.thinking
	 * is true. The validator enforces this invariant; this interface doesn't
	 * encode it structurally because doing so would require a second
	 * discriminated union at the request level, which overcomplicates the
	 * consumer API for one rarely-varied field.
	 */
	readonly performanceConfig?: PerformanceConfig;
	readonly toolConfig?: {
		readonly tools: readonly {
			readonly toolSpec: {
				readonly name: ToolName;
				readonly description: string;
				readonly inputSchema: { readonly json: Record<string, unknown> };
			};
		}[];
	};
}

// Re-export element-level types for convenience.
export type {
	AssistantMessage,
	InferenceConfig,
	PerformanceConfig,
	SystemBlock,
	ToolName,
	UserMessage,
	ValidatedMessage,
};
