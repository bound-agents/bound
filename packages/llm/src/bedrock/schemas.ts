/**
 * Zod schemas for the Bedrock Converse API input shape.
 *
 * These schemas are the single source of truth for both:
 *   - runtime validation (via z.safeParse inside type guards)
 *   - TS types (via z.infer)
 *
 * If you refactor a schema, the TS type updates, the guard updates, and any
 * downstream consumer that matched on the old fields fails to compile. That
 * is the whole point of using zod here.
 *
 * The types here mirror the AWS SDK's `Message` / `ContentBlock` union
 * (@aws-sdk/client-bedrock-runtime), but constrained to the subset we
 * actually send. We don't model fields we never produce (guardrails,
 * cachePoint, videoContent, etc.).
 */

import { z } from "zod";

// ─── Leaf scalars ───────────────────────────────────────────────────────────

/**
 * Non-empty string. Bedrock rejects empty `text` blocks with a ValidationException.
 */
export const NonEmptyStringSchema = z.string().min(1);

/**
 * Tool name constraint from the Bedrock API: ^[a-zA-Z0-9_-]{1,64}$.
 * `sanitizeToolName` should have already enforced this upstream; we re-check
 * at the boundary so violations fail fast with a typed error instead of a
 * ValidationException from AWS.
 */
export const ToolNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/);

/**
 * Non-empty `toolUseId`. Bedrock requires this on both toolUse (assistant)
 * and toolResult (user) blocks, and rejects empty strings.
 */
export const ToolUseIdSchema = z.string().min(1);

/**
 * Image formats Bedrock's Converse API accepts.
 */
export const ImageFormatSchema = z.enum(["png", "jpeg", "gif", "webp"]);

// ─── Content blocks ─────────────────────────────────────────────────────────

/**
 * A plain text block. Non-empty — if we have no text, we don't emit a block.
 */
export const TextBlockSchema = z.object({
	text: NonEmptyStringSchema,
});

/**
 * An image block. Bytes must be a Uint8Array with length > 0.
 * (AWS SDK accepts base64 strings too, but our driver always converts to bytes.)
 */
export const ImageBlockSchema = z.object({
	image: z.object({
		format: ImageFormatSchema,
		source: z.object({
			bytes: z.instanceof(Uint8Array).refine((b) => b.length > 0, {
				message: "image bytes must be non-empty",
			}),
		}),
	}),
});

/**
 * Assistant-emitted `toolUse` block.
 */
export const ToolUseBlockSchema = z.object({
	toolUse: z.object({
		toolUseId: ToolUseIdSchema,
		name: ToolNameSchema,
		// AWS SDK's DocumentType is recursive; z.record(z.any()) is the pragmatic match.
		input: z.record(z.string(), z.any()),
	}),
});

/**
 * User-emitted `toolResult` block — the response to an assistant's `toolUse`.
 *
 * Nested content is [ { text }, ...image blocks ]. We require at least one
 * block; in practice the converter always emits a text block first.
 */
export const ToolResultBlockSchema = z.object({
	toolResult: z.object({
		toolUseId: ToolUseIdSchema,
		content: z.array(z.union([TextBlockSchema, ImageBlockSchema])).min(1),
	}),
});

/**
 * Assistant-emitted `reasoningContent` block (extended thinking).
 *
 * The SDK's shape uses a `reasoningText` nested object; we mirror that. The
 * signature is optional because not every reasoning block carries one.
 */
export const ReasoningContentBlockSchema = z.object({
	reasoningContent: z.object({
		reasoningText: z.object({
			text: NonEmptyStringSchema,
			signature: z.string().optional(),
		}),
	}),
});

// ─── Role-specific content-block unions ─────────────────────────────────────

/**
 * CachePoint block — an undocumented Bedrock feature for prompt caching.
 *
 * When present in a message's content, Bedrock caches all content up to and
 * including that point. Not in the SDK's public types, but accepted by the
 * Converse API. Can appear in both user and assistant messages, as well as
 * inside system blocks (see SystemBlockSchema below).
 */
export const CachePointBlockSchema = z.object({
	cachePoint: z.object({ type: z.literal("default") }),
});

/**
 * Content blocks a user message may contain.
 *
 * Bedrock allows user messages to contain text, images, and tool results.
 * CachePoint is a marker block that rides alongside.
 */
export const UserContentBlockSchema = z.union([
	TextBlockSchema,
	ImageBlockSchema,
	ToolResultBlockSchema,
	CachePointBlockSchema,
]);

/**
 * Content blocks an assistant message may contain.
 *
 * Bedrock rejects images in assistant messages — the model emits text,
 * tool calls, and reasoning. Splitting the unions at the type level makes
 * "assistant with an image" impossible to construct. CachePoint is allowed
 * as a marker.
 */
export const AssistantContentBlockSchema = z.union([
	TextBlockSchema,
	ToolUseBlockSchema,
	ReasoningContentBlockSchema,
	CachePointBlockSchema,
]);

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * A validated user message. Content is a non-empty array of user-legal blocks.
 */
export const UserMessageSchema = z.object({
	role: z.literal("user"),
	content: z.array(UserContentBlockSchema).min(1),
});

/**
 * A validated assistant message. Content is a non-empty array of assistant-legal blocks.
 */
export const AssistantMessageSchema = z.object({
	role: z.literal("assistant"),
	content: z.array(AssistantContentBlockSchema).min(1),
});

/**
 * A single validated message (either role).
 */
export const ValidatedMessageSchema = z.union([UserMessageSchema, AssistantMessageSchema]);

// ─── System blocks ──────────────────────────────────────────────────────────

/**
 * A system prompt block. Bedrock accepts an array of these; we emit one or two
 * (cached prefix + uncached suffix) depending on cache configuration.
 *
 * System blocks can also carry CachePoint markers between text blocks.
 */
export const SystemBlockSchema = z.union([
	z.object({ text: NonEmptyStringSchema }),
	CachePointBlockSchema,
]);

// ─── Inference configuration ────────────────────────────────────────────────

/**
 * Inference configuration, split by reasoning mode.
 *
 * When thinking is enabled, Bedrock rejects requests that also set
 * `temperature` — the model's reasoning loop manages sampling itself.
 * Modeling this as a discriminated union makes "thinking + temperature"
 * impossible to construct.
 */
export const InferenceConfigNoThinkingSchema = z.object({
	thinking: z.literal(false),
	maxTokens: z.number().int().positive().optional(),
	temperature: z.number().min(0).max(1).optional(),
});

export const InferenceConfigThinkingSchema = z
	.object({
		thinking: z.literal(true),
		maxTokens: z.number().int().positive(),
		// temperature explicitly absent — zod rejects extra keys only if we
		// .strict(), which we do:
	})
	.strict();

export const InferenceConfigSchema = z.discriminatedUnion("thinking", [
	InferenceConfigNoThinkingSchema,
	InferenceConfigThinkingSchema,
]);

// ─── Additional model request fields (extended thinking) ────────────────────

/**
 * Anthropic-specific request parameters that Bedrock Converse routes to the
 * underlying Claude API via `additionalModelRequestFields` — a freeform
 * `DocumentType` bag for provider-specific knobs that aren't in the Converse
 * schema proper.
 *
 * For extended thinking, the shape is Anthropic's *native* one:
 *
 *   { thinking: { type: "enabled", budget_tokens: N } }
 *
 * Note `budget_tokens` (snake_case) — NOT `budgetTokens`. Bedrock forwards
 * this payload unchanged to Claude, so the field names must match the
 * Anthropic API, not AWS-style camelCase.
 *
 * Only present when InferenceConfig has `thinking: true`. The driver should
 * never emit additionalModelRequestFields without thinking, and the validator
 * cross-checks this at the request level.
 *
 * Historical note: an earlier version of this schema used
 * `performanceConfig.thinking.budgetTokens`, which was wrong on both axes —
 * performanceConfig is for latency-tier selection (optimized vs. standard),
 * not reasoning. The wrong shape was silently ignored by Bedrock, causing
 * the model to emit "[Thinking: …]" as inline text instead of routing it
 * through a proper reasoning channel.
 */
export const AdditionalModelRequestFieldsSchema = z.object({
	thinking: z.object({
		type: z.literal("enabled"),
		budget_tokens: z.number().int().positive(),
	}),
});

// ─── Inferred TS types ──────────────────────────────────────────────────────

export type NonEmptyString = z.infer<typeof NonEmptyStringSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolUseId = z.infer<typeof ToolUseIdSchema>;
export type ImageFormat = z.infer<typeof ImageFormatSchema>;

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ReasoningContentBlock = z.infer<typeof ReasoningContentBlockSchema>;

export type UserContentBlock = z.infer<typeof UserContentBlockSchema>;
export type AssistantContentBlock = z.infer<typeof AssistantContentBlockSchema>;

export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ValidatedMessage = z.infer<typeof ValidatedMessageSchema>;

export type SystemBlock = z.infer<typeof SystemBlockSchema>;
export type InferenceConfig = z.infer<typeof InferenceConfigSchema>;
export type AdditionalModelRequestFields = z.infer<typeof AdditionalModelRequestFieldsSchema>;
export type CachePointBlock = z.infer<typeof CachePointBlockSchema>;
