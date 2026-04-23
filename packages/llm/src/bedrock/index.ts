/**
 * Public surface of the Bedrock validated-types module.
 *
 * This is the airlock between raw/dynamic request construction and the
 * Bedrock Converse HTTP client. The driver imports from here and only here.
 *
 * Exports are intentionally narrow:
 *   - `validateBedrockRequest` is the ONLY way to produce a
 *     `BedrockValidatedRequest`.
 *   - The branded types are opaque at the type level; consumers cannot
 *     fabricate a `BedrockValidatedConversation` without going through the
 *     validator.
 *   - `BedrockValidationError` is exported so callers (logging, alerting,
 *     retry layers) can pattern-match on structured error codes.
 */

export type { Branded, Unbranded } from "./brand";

export {
	BedrockValidationError,
	type BedrockValidationDetail,
	type BedrockValidationErrorCode,
} from "./errors";

export {
	AssistantContentBlockSchema,
	AssistantMessageSchema,
	CachePointBlockSchema,
	ImageBlockSchema,
	ImageFormatSchema,
	InferenceConfigSchema,
	NonEmptyStringSchema,
	AdditionalModelRequestFieldsSchema,
	ReasoningContentBlockSchema,
	SystemBlockSchema,
	TextBlockSchema,
	ToolNameSchema,
	ToolResultBlockSchema,
	ToolUseBlockSchema,
	ToolUseIdSchema,
	UserContentBlockSchema,
	UserMessageSchema,
	ValidatedMessageSchema,
	type AssistantContentBlock,
	type AssistantMessage,
	type CachePointBlock,
	type ImageBlock,
	type ImageFormat,
	type InferenceConfig,
	type NonEmptyString,
	type AdditionalModelRequestFields,
	type ReasoningContentBlock,
	type SystemBlock,
	type TextBlock,
	type ToolName,
	type ToolResultBlock,
	type ToolUseBlock,
	type ToolUseId,
	type UserContentBlock,
	type UserMessage,
	type ValidatedMessage,
} from "./schemas";

export type {
	BedrockValidatedConversation,
	BedrockValidatedRequest,
	StaticAlternating,
	StaticConversationInput,
} from "./validated-types";

export { validateBedrockRequest, type RawBedrockRequest } from "./validate";
