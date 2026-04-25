/**
 * Converter — takes the internal LLMMessage[] + ChatParams shape and produces
 * a RawBedrockRequest ready for the validator.
 *
 * This is pure data shaping. It does NOT enforce invariants; that's the
 * validator's job. Keeping conversion separate from validation means:
 *   - The converter can be tested with plain-object equality (no mocking).
 *   - The validator can be tested on hand-crafted raw inputs without going
 *     through conversion.
 *   - The driver wiring is trivial: convert → validate → send.
 *
 * Invariants the converter TRIES to establish (by construction) but the
 * validator re-checks as a belt-and-braces:
 *   - first message is user (prepends <system-notification /> if not)
 *   - last message is user (appends <continue /> if not)
 *   - consecutive same-role messages are merged
 *   - blank text blocks get EMPTY_TEXT_PLACEHOLDER
 *
 * If a bug sneaks into the converter and one of these invariants gets
 * violated, the validator catches it rather than the Bedrock API. That's the
 * airlock at work.
 */

import type { DocumentType } from "@smithy/types";
import { sniffImageMediaType } from "../image-utils";
import { extractTextFromBlocks, sanitizeToolName } from "../stream-utils";
import type { ChatParams, LLMMessage, ToolDefinition } from "../types";
import type { RawBedrockRequest } from "./validate";

// Bedrock rejects blank text in content blocks. Use this placeholder.
const EMPTY_TEXT_PLACEHOLDER = "(empty)";

/**
 * Convert an array of internal LLMMessages into the Bedrock "messages" shape.
 * Handles role mapping, tool_call / tool_result flattening, image encoding,
 * consecutive-same-role merging, and boundary-padding.
 */
export function toBedrockMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];
	const pendingDeveloperContent: string[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			// System messages are handled separately via the system prompt param.
			continue;
		}

		// Handle developer role: buffer content to prepend to next user message
		if (msg.role === "developer") {
			const text =
				typeof msg.content === "string" ? msg.content : extractTextFromBlocks(msg.content);
			pendingDeveloperContent.push(`<system-context>${text}</system-context>`);
			continue;
		}

		// Handle cache role: append cachePoint to previous message
		if (msg.role === "cache") {
			const prev = result.at(-1);
			if (prev && Array.isArray(prev.content)) {
				(prev.content as Array<Record<string, unknown>>).push({
					cachePoint: { type: "default" },
				});
			}
			continue;
		}

		// Skip non-standard roles (e.g. alert, purge) that Bedrock can't consume.
		// These should be filtered upstream; this is a defensive guard.
		if (
			msg.role !== "user" &&
			msg.role !== "assistant" &&
			msg.role !== "tool_call" &&
			msg.role !== "tool_result"
		) {
			continue;
		}

		if (msg.role === "tool_call") {
			// Internal "tool_call" maps to a Bedrock assistant message carrying
			// toolUse blocks (and optionally reasoning + text).
			const content: Array<Record<string, unknown>> = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "thinking") {
						const reasoningText: Record<string, unknown> = { text: block.thinking };
						if (block.signature) reasoningText.signature = block.signature;
						content.push({ reasoningContent: { reasoningText } });
					} else if (block.type === "tool_use") {
						content.push({
							toolUse: {
								toolUseId: block.id,
								name: sanitizeToolName(block.name),
								input: block.input as DocumentType,
							},
						});
					} else if (block.type === "text") {
						content.push({ text: block.text });
					}
				}
			} else {
				// DB stores tool_call content as a JSON string — try parsing it.
				try {
					const parsed = JSON.parse(msg.content);
					if (Array.isArray(parsed)) {
						for (const block of parsed) {
							if (block.type === "thinking") {
								const reasoningText: Record<string, unknown> = { text: block.thinking };
								if (block.signature) reasoningText.signature = block.signature;
								content.push({ reasoningContent: { reasoningText } });
							} else if (block.type === "tool_use") {
								content.push({
									toolUse: {
										toolUseId: block.id ?? "",
										name: sanitizeToolName(block.name ?? ""),
										input: (block.input ?? {}) as DocumentType,
									},
								});
							}
						}
					}
				} catch {
					content.push({ text: msg.content });
				}
			}
			result.push({
				role: "assistant",
				content: content.length > 0 ? content : [{ text: EMPTY_TEXT_PLACEHOLDER }],
			});
			continue;
		}

		if (msg.role === "tool_result") {
			const toolUseId = msg.tool_use_id || `synthetic-${Date.now()}-${result.length}`;
			const textContent = Array.isArray(msg.content)
				? extractTextFromBlocks(msg.content)
				: msg.content;
			const toolResultContent: Array<Record<string, unknown>> = [{ text: textContent }];
			// Preserve images from tool results (e.g. MCP screenshot tools).
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "image" && block.source?.type === "base64") {
						const bytes = Uint8Array.from(atob(block.source.data), (c) => c.charCodeAt(0));
						const sniffed = sniffImageMediaType(bytes) ?? block.source.media_type;
						const format = sniffed.replace("image/", "") as "png" | "jpeg" | "gif" | "webp";
						toolResultContent.push({ image: { format, source: { bytes } } });
					}
				}
			}
			const toolResultBlock = {
				toolResult: { toolUseId, content: toolResultContent },
			};
			// Merge consecutive tool_result messages into one user message.
			// Bedrock requires ALL toolResult blocks for a multi-tool turn to
			// share a single user message.
			const lastMsg = result.at(-1);
			if (
				lastMsg?.role === "user" &&
				Array.isArray(lastMsg.content) &&
				(lastMsg.content as Array<Record<string, unknown>>).some((b) => "toolResult" in b)
			) {
				(lastMsg.content as Array<Record<string, unknown>>).push(toolResultBlock);
			} else {
				result.push({ role: "user", content: [toolResultBlock] });
			}
			continue;
		}

		// Plain user / assistant with text or structured content blocks.
		const role = msg.role as "user" | "assistant";

		// For user messages, prepend any pending developer content
		if (role === "user" && pendingDeveloperContent.length > 0) {
			const content: Array<Record<string, unknown>> = [];
			// Save developer block count before clearing
			const devBlockCount = pendingDeveloperContent.length;
			// Add pending developer content as wrapped text blocks
			for (const devContent of pendingDeveloperContent) {
				content.push({ text: devContent });
			}
			pendingDeveloperContent.length = 0;

			// Then add the user's actual content
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						content.push({ text: block.text });
					} else if (block.type === "image" && block.source) {
						const src = block.source;
						if (src.type === "base64") {
							const bytes = Uint8Array.from(atob(src.data), (c) => c.charCodeAt(0));
							const sniffed = sniffImageMediaType(bytes) ?? src.media_type;
							const format = sniffed.replace("image/", "") as "png" | "jpeg" | "gif" | "webp";
							content.push({ image: { format, source: { bytes } } });
						}
					}
				}
				if (content.length <= devBlockCount) {
					content.push({ text: extractTextFromBlocks(msg.content) || EMPTY_TEXT_PLACEHOLDER });
				}
			} else {
				content.push({ text: msg.content || EMPTY_TEXT_PLACEHOLDER });
			}
			result.push({ role, content });
		} else if (Array.isArray(msg.content)) {
			const content: Array<Record<string, unknown>> = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					content.push({ text: block.text });
				} else if (block.type === "image" && block.source) {
					const src = block.source;
					if (src.type === "base64") {
						const bytes = Uint8Array.from(atob(src.data), (c) => c.charCodeAt(0));
						const sniffed = sniffImageMediaType(bytes) ?? src.media_type;
						const format = sniffed.replace("image/", "") as "png" | "jpeg" | "gif" | "webp";
						content.push({ image: { format, source: { bytes } } });
					}
				}
			}
			if (content.length === 0) {
				content.push({ text: extractTextFromBlocks(msg.content) || EMPTY_TEXT_PLACEHOLDER });
			}
			result.push({ role, content });
		} else {
			result.push({ role, content: [{ text: msg.content || EMPTY_TEXT_PLACEHOLDER }] });
		}
	}

	// If there's still pending developer content (no user message followed it),
	// inject it as a user message
	if (pendingDeveloperContent.length > 0) {
		const content: Array<Record<string, unknown>> = [];
		for (const devContent of pendingDeveloperContent) {
			content.push({ text: devContent });
		}
		result.push({ role: "user", content });
	}

	// Bedrock's alternation invariant: merge consecutive same-role messages.
	const merged: Array<Record<string, unknown>> = [];
	for (const msg of result) {
		const last = merged.at(-1);
		if (
			last &&
			last.role === msg.role &&
			Array.isArray(last.content) &&
			Array.isArray(msg.content)
		) {
			(last.content as Array<unknown>).push(...(msg.content as Array<unknown>));
		} else {
			merged.push(msg);
		}
	}

	// Bedrock requires the conversation to start with a user message.
	// (Scheduled-task threads can start with tool_call/tool_result; pad here.)
	if (merged.length > 0 && merged[0].role !== "user") {
		merged.unshift({
			role: "user",
			content: [{ text: "<system-notification />" }],
		});
	}

	// Bedrock requires the conversation to end with a user message (no assistant
	// prefill). Pad when the sanitizer's reordering leaves an assistant last.
	if (merged.length > 0 && merged.at(-1)?.role !== "user") {
		merged.push({
			role: "user",
			content: [{ text: "<continue />" }],
		});
	}

	return merged;
}

/**
 * The input type for toBedrockRequest. Wraps ChatParams plus the driver's
 * default model, so the converter has everything it needs in one arg.
 */
export interface ConvertInput {
	readonly params: ChatParams;
	/** The driver's configured default model, used when params.model is absent. */
	readonly defaultModel: string;
}

/**
 * Produce a RawBedrockRequest from ChatParams. This is the single seam the
 * driver uses to shape the API call; after this, only the validator runs
 * before the HTTP request goes out.
 */
export function toBedrockRequest(input: ConvertInput): RawBedrockRequest {
	const { params, defaultModel } = input;
	const modelId = params.model || defaultModel;

	// ─── Messages + cache message handling ──────────────────────────────────
	const messages = toBedrockMessages(params.messages);

	// ─── System blocks ───────────────────────────────────────────────────────
	// Two shapes:
	//   - No system prompt → undefined
	//   - System only, no cache → [{text}]
	//   - System only, cache    → [{text},{cachePoint}]
	const hasCacheMessages = params.messages.some((m) => m.role === "cache");
	const systemBlocks: Array<Record<string, unknown>> | undefined = (() => {
		if (!params.system) return undefined;

		// System only.
		const blocks: Array<Record<string, unknown>> = [{ text: params.system }];
		if (hasCacheMessages) blocks.push({ cachePoint: { type: "default" } });
		return blocks;
	})();

	// ─── Tool config ─────────────────────────────────────────────────────────
	// Per the AWS SDK shape (ToolConfiguration), there is no top-level
	// `cachePoint` field — the ToolConfiguration interface only carries
	// `tools: Tool[]` and an optional `toolChoice`. The Tool union itself
	// has a `CachePointMember` variant, so the cachePoint marker must be
	// appended as the final element of the `tools` array.
	//
	// Putting `cachePoint` at `toolConfig.cachePoint` (the old shape) caused
	// Bedrock to forward it to the underlying Claude API as cache_control
	// on multiple tools, inflating the total cache_control count past the
	// hard 4-block API limit and producing:
	//   "A maximum of 4 blocks with cache_control may be provided. Found 5."
	const toolConfig: Record<string, unknown> | undefined =
		params.tools && params.tools.length > 0
			? {
					tools: params.tools.map((t: ToolDefinition) => ({
						toolSpec: {
							name: sanitizeToolName(t.function.name),
							description: t.function.description,
							inputSchema: { json: t.function.parameters as Record<string, unknown> },
						},
					})) as Array<Record<string, unknown>>,
				}
			: undefined;

	// Append cachePoint as the last element of the tools array when cache
	// messages are present. This caches all preceding tool definitions per
	// Bedrock's contiguous-prefix caching rule.
	if (hasCacheMessages && toolConfig) {
		(toolConfig.tools as Array<Record<string, unknown>>).push({
			cachePoint: { type: "default" },
		});
	}

	// ─── Inference config ────────────────────────────────────────────────────
	// Bedrock's own `inferenceConfig.thinking` discriminant governs its
	// legacy reasoning pathway, which corresponds 1:1 with Anthropic's
	// `{type: "enabled", budget_tokens}` shape. Adaptive thinking (Opus
	// 4.6+, required on 4.7) is a native Anthropic concept Bedrock does
	// not model — we pass `inferenceConfig.thinking: false` and route
	// the full adaptive spec through additionalModelRequestFields.
	//
	// Opus 4.7 rejects temperature/top_p/top_k entirely; Anthropic's
	// legacy thinking mode rejected temperature anyway. Drop temperature
	// when either thinking mode is active to stay safe on both paths.
	const isLegacyThinking = params.thinking?.type === "enabled";
	const isAdaptiveThinking = params.thinking?.type === "adaptive";
	const anyThinkingActive = isLegacyThinking || isAdaptiveThinking;
	const inferenceConfig = isLegacyThinking
		? {
				thinking: true as const,
				// Thinking requires maxTokens; use max_tokens if set, otherwise
				// fall back to the thinking budget + some headroom. Bedrock rejects
				// maxTokens < budget_tokens.
				maxTokens:
					params.max_tokens ??
					(params.thinking as { type: "enabled"; budget_tokens: number }).budget_tokens + 4096,
			}
		: {
				thinking: false as const,
				...(!anyThinkingActive &&
					params.temperature !== undefined && { temperature: params.temperature }),
				...(params.max_tokens && { maxTokens: params.max_tokens }),
			};

	// ─── Additional model request fields ────────────────────────────────────
	// Bedrock Converse routes Anthropic-specific knobs through
	// `additionalModelRequestFields` — a passthrough bag forwarded
	// unchanged to the Claude API. Field names follow Anthropic's native
	// snake_case (e.g. `budget_tokens`, `output_config`).
	//
	// Historical note: an earlier version sent this as
	// `performanceConfig.thinking.budgetTokens`, which Bedrock silently
	// ignored — the model would then emit reasoning as inline
	// "[Thinking: …]" text instead of via the reasoningContent channel.
	const additionalBag: Record<string, unknown> = {};
	if (isLegacyThinking) {
		additionalBag.thinking = {
			type: "enabled" as const,
			budget_tokens: (params.thinking as { type: "enabled"; budget_tokens: number }).budget_tokens,
		};
	} else if (isAdaptiveThinking) {
		const adaptive = params.thinking as {
			type: "adaptive";
			display?: "omitted" | "summarized";
		};
		additionalBag.thinking = {
			type: "adaptive" as const,
			...(adaptive.display !== undefined && { display: adaptive.display }),
		};
	}
	if (params.effort) {
		additionalBag.output_config = { effort: params.effort };
	}
	const additionalModelRequestFields =
		Object.keys(additionalBag).length > 0 ? additionalBag : undefined;

	return {
		modelId,
		messages,
		system: systemBlocks,
		inferenceConfig,
		additionalModelRequestFields,
		toolConfig,
	};
}
