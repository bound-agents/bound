/**
 * Shared conversion helpers between Bound's LLM shapes and the Vercel AI SDK.
 *
 * The driver layer used to be ~2400 lines of hand-rolled message assembly,
 * streaming parsers, and provider-specific quirk handling. It now lives here
 * plus two thin driver shims (bedrock-driver.ts, openai-compatible-driver.ts).
 *
 * Responsibilities:
 *   - toModelMessages: LLMMessage[] → ModelMessage[] (AI SDK input shape),
 *     including cache-marker flattening and tool_call/tool_result wrapping.
 *   - toToolSet: ToolDefinition[] → ToolSet (AI SDK tool shape) via
 *     jsonSchema() so we don't force a zod round-trip.
 *   - mapChunks: AI SDK fullStream → StreamChunk (our downstream shape).
 *   - mapError: unknown → LLMError with best-effort HTTP status extraction.
 *
 * Provider-specific behavior (cache control, reasoning config, etc.) is
 * injected by the caller via providerOptions — see the individual drivers.
 */

import { formatError } from "@bound/shared";
import { tool as aiTool, jsonSchema } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type { ContentBlock, LLMMessage, StreamChunk, ToolDefinition } from "./types";
import { LLMError } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Message conversion
// ─────────────────────────────────────────────────────────────────────────────

export interface ToModelMessagesOptions {
	/**
	 * Provider key used on the cache-marker passthrough. Bedrock expects
	 * `providerOptions.bedrock.cachePoint`, Anthropic expects
	 * `providerOptions.anthropic.cacheControl`. OpenAI-compatible providers
	 * generally don't support prompt caching via provider options, but the
	 * marker role is still dropped harmlessly here.
	 */
	cacheProvider?: "bedrock" | "anthropic" | null;
	/**
	 * Resolves a `file_ref` source to inline base64 data. See
	 * ChatParams.resolveFileRef for the full contract — this is the same
	 * callback, threaded through driver → bridge.
	 */
	resolveFileRef?: (fileId: string) => string | null;
}

/**
 * Convert Bound's LLMMessage shape to AI SDK ModelMessage.
 *
 * Role mapping:
 *   user       → user
 *   assistant  → assistant
 *   system     → system
 *   developer  → merged into an adjacent user message, wrapped in a
 *                `<system-context>` tag. Developer messages are emitted
 *                interleaved with history (the agent loop appends one at the
 *                tail every turn), so promoting them to AI SDK `system`
 *                messages produces the "Multiple system messages separated by
 *                user/assistant" failure on Bedrock. Merge into the next user
 *                message when one follows, or append to the most recent user
 *                message when none does. Orphan developer messages (no user
 *                anywhere) are dropped — the resulting request would be
 *                unsendable otherwise.
 *   tool_call  → assistant { parts: [tool-call...] }
 *   tool_result → tool { parts: [tool-result...] }
 *   cache      → marker only — attached to the previous message via
 *                providerOptions.{cacheProvider}.cachePoint / cacheControl
 */
export function toModelMessages(
	messages: LLMMessage[],
	opts: ToModelMessagesOptions = {},
): ModelMessage[] {
	const result: ModelMessage[] = [];

	// First pass: build a tool-call id → name index. Tool-result messages
	// need the toolName to satisfy ToolResultPart (provider-utils). Bedrock's
	// Converse path ignores it, but Anthropic direct and other providers wire
	// it through, and the schema requires it. Index everything up front so
	// out-of-order or interleaved messages still resolve correctly.
	const toolNameById = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "assistant" && msg.role !== "tool_call") continue;
		const blocks = Array.isArray(msg.content) ? msg.content : normalizeBlocks(msg.content);
		for (const b of blocks) {
			if (b.type === "tool_use") toolNameById.set(b.id, b.name);
		}
	}

	// Developer content accumulated since the last user message. Flushed by
	// prepending into the next user message; any remainder is appended onto
	// the last emitted user message after the loop.
	const pendingDev: string[] = [];

	for (const msg of messages) {
		if (msg.role === "developer") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text) pendingDev.push(text);
			continue;
		}

		if (msg.role === "cache") {
			// Attach a cache breakpoint to the most recently emitted message.
			const prev = result[result.length - 1];
			if (!prev || !opts.cacheProvider) continue;
			if (!prev.providerOptions) prev.providerOptions = {};
			const provOpts = prev.providerOptions as Record<string, Record<string, unknown>>;
			if (!provOpts[opts.cacheProvider]) provOpts[opts.cacheProvider] = {};
			const bucket = provOpts[opts.cacheProvider];
			if (opts.cacheProvider === "bedrock") {
				bucket.cachePoint = { type: "default" };
			} else if (opts.cacheProvider === "anthropic") {
				bucket.cacheControl = { type: "ephemeral" };
			}
			continue;
		}

		if (msg.role === "tool_call") {
			const blocks = normalizeBlocks(msg.content);
			const parts: Array<Record<string, unknown>> = [];
			for (const b of blocks) {
				if (b.type === "text" && b.text) {
					parts.push({ type: "text", text: b.text });
				} else if (b.type === "thinking") {
					parts.push(buildReasoningPart(b));
				} else if (b.type === "tool_use") {
					parts.push({
						type: "tool-call",
						toolCallId: b.id,
						toolName: b.name,
						input: b.input,
					});
				}
			}
			result.push({ role: "assistant", content: parts as never });
			continue;
		}

		if (msg.role === "tool_result") {
			const blocks = normalizeBlocks(msg.content);
			const toolCallId = msg.tool_use_id ?? "";
			result.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId,
						// Resolved from the prior tool-call index; fall back to ""
						// if the tool_result arrives without a matching call (which
						// would be a caller bug but we don't want to throw here).
						toolName: toolNameById.get(toolCallId) ?? "",
						output: buildToolResultOutput(blocks, opts.resolveFileRef),
					},
				] as never,
			});
			continue;
		}

		// user / assistant / system with content blocks
		const isUser = msg.role === "user";
		if (typeof msg.content === "string") {
			if (isUser && pendingDev.length > 0) {
				result.push({
					role: "user",
					content: `${wrapDev(pendingDev)}\n\n${msg.content}`,
				});
				pendingDev.length = 0;
			} else {
				result.push({
					role: msg.role as "user" | "assistant" | "system",
					content: msg.content,
				} as ModelMessage);
			}
			continue;
		}

		const parts: Array<Record<string, unknown>> = [];
		const isAssistant = msg.role === "assistant";
		for (const b of msg.content) {
			if (b.type === "text") {
				if (b.text) parts.push({ type: "text", text: b.text });
			} else if (b.type === "thinking") {
				parts.push(buildReasoningPart(b));
			} else if (b.type === "tool_use") {
				parts.push({
					type: "tool-call",
					toolCallId: b.id,
					toolName: b.name,
					input: b.input,
				});
			} else if (b.type === "image") {
				// AssistantContent in @ai-sdk/provider-utils is
				//   string | Array<TextPart | FilePart | ReasoningPart
				//                   | ToolCallPart | ToolResultPart>
				// — it does NOT include ImagePart. UserContent does.
				//
				// On assistant messages, route through FilePart (which IS allowed)
				// so we faithfully preserve assistant-generated images rather than
				// reducing them to a text description.
				const imgPart = buildImageOrFilePart(b, {
					asFile: isAssistant,
					resolveFileRef: opts.resolveFileRef,
				});
				if (imgPart) {
					parts.push(imgPart);
				} else {
					// file_ref couldn't be resolved (no resolver, or file
					// missing). Emit a clear placeholder so the model is
					// informed an image was attempted — never silently drop.
					parts.push({ type: "text", text: imageUnavailablePlaceholder(b) });
				}
			} else if (b.type === "document") {
				const docPart = buildDocumentPart(b, opts.resolveFileRef);
				if (docPart) {
					parts.push(docPart);
				} else {
					// file_ref couldn't be resolved AND no text_representation
					// — emit a clear placeholder so the model is informed a
					// document was attempted, rather than silently dropping.
					parts.push({ type: "text", text: documentUnavailablePlaceholder(b) });
				}
			}
		}

		if (isUser && pendingDev.length > 0) {
			parts.unshift({ type: "text", text: wrapDev(pendingDev) });
			pendingDev.length = 0;
		}

		if (parts.length === 0) {
			// Tool-call-only assistant messages with no parts would be dropped
			// by the SDK; synthesize an empty text part to keep ordering stable.
			parts.push({ type: "text", text: "" });
		}

		result.push({
			role: msg.role as "user" | "assistant" | "system",
			content: parts as never,
		});
	}

	// Any developer content still pending here appeared after the last user
	// message (e.g., the rolling volatile-context tail the agent loop appends
	// every turn). Append to the most recent user message so it still reaches
	// the model in the right position relative to history.
	if (pendingDev.length > 0) {
		let attached = false;
		for (let i = result.length - 1; i >= 0; i--) {
			if (result[i].role === "user") {
				appendDevToUser(result[i], pendingDev);
				pendingDev.length = 0;
				attached = true;
				break;
			}
		}
		// No user message exists anywhere — scheduler wakeup threads look
		// like [developer, tool_call, tool_result] by design (the task
		// payload rides on the synthetic tool_result; see scheduler.ts).
		// Promote the pending dev content into a synthetic user-role message
		// at the head so the conversation is sendable. Previously this was
		// silently dropped, which surfaced downstream as a Bedrock 400
		// "A conversation must start with a user message".
		if (!attached) {
			result.unshift({ role: "user", content: wrapDev(pendingDev) });
			pendingDev.length = 0;
		}
	}

	// Conversation-start invariant: most providers (Bedrock, Anthropic
	// direct, Mistral, …) reject requests whose first message isn't from the
	// user. Defense-in-depth for inputs that start with assistant/tool/system
	// even without developer content (e.g., post-restart retries where the
	// history begins mid-turn). The old hand-rolled toBedrockMessages carried
	// an equivalent guard; we preserve the "<system-notification />" shape
	// for continuity with any operator tooling that looks for it.
	if (result.length > 0 && result[0].role !== "user") {
		result.unshift({ role: "user", content: "<system-notification />" });
	}

	return result;
}

function wrapDev(lines: string[]): string {
	return `<system-context>\n${lines.join("\n\n")}\n</system-context>`;
}

function appendDevToUser(userMsg: ModelMessage, devLines: string[]): void {
	const wrapped = wrapDev(devLines);
	if (typeof userMsg.content === "string") {
		userMsg.content = `${userMsg.content}\n\n${wrapped}`;
		return;
	}
	// Content-block user message: push as a trailing text part so we don't
	// have to merge with any final block's internals (image/file parts, etc.).
	(userMsg.content as Array<Record<string, unknown>>).push({ type: "text", text: wrapped });
}

function normalizeBlocks(content: string | ContentBlock[]): ContentBlock[] {
	if (Array.isArray(content)) return content;
	// DB serializes tool_call/tool_result content as JSON strings of blocks;
	// fall back to treating the string as a single text block if parse fails
	// or if the parsed array isn't actually content-block-shaped.
	//
	// The shape gate matters because tools (especially the connector tool) are
	// free to return arbitrary JSON arrays as their result string. Without the
	// gate, normalizeBlocks would happily return those arrays, the downstream
	// `b.type === "text"` filter in the tool_result handler would drop every
	// item, and the model would see an empty tool result. Treating opaque
	// JSON-array payloads as a single text block keeps the data intact.
	try {
		const parsed = JSON.parse(content);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every(
				(b) => b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string",
			)
		) {
			return parsed as ContentBlock[];
		}
	} catch {
		// fallthrough
	}
	return [{ type: "text", text: content }];
}

function extractText(blocks: ContentBlock[]): string {
	return blocks
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

/**
 * Build an AI SDK ReasoningPart from a thinking ContentBlock.
 *
 * Both signature and redacted_data live under providerOptions.bedrock
 * (Anthropic direct uses providerOptions.anthropic.signature; redacted data
 * is Bedrock-only in practice). The bedrock provider options schema accepts
 * both keys simultaneously, so we route them through a single bucket.
 */
function buildReasoningPart(b: Extract<ContentBlock, { type: "thinking" }>) {
	const bedrock: Record<string, unknown> = {};
	if (b.signature) bedrock.signature = b.signature;
	if (b.redacted_data) bedrock.redactedData = b.redacted_data;
	const providerOptions = Object.keys(bedrock).length > 0 ? { bedrock } : undefined;
	return {
		type: "reasoning" as const,
		text: b.thinking,
		...(providerOptions && { providerOptions }),
	};
}

/**
 * Resolve an image block's source to {data, mediaType} when possible.
 *
 * Returns:
 *   - {data, mediaType} when the source is base64, OR when it's a file_ref
 *     and the resolver returns bytes.
 *   - null when the source is a file_ref the resolver couldn't fetch (or no
 *     resolver was provided) — caller emits a placeholder so the model is
 *     informed an image was attempted but unavailable.
 *
 * media_type fallback for file_refs: image blocks may carry a media_type
 * hint on the source itself (stamped at upload time, e.g. Discord
 * contentType). When absent we default to image/jpeg, mirroring
 * context-assembly.substituteUnsupportedBlocks's legacy fallback.
 */
function resolveImageSource(
	source: Extract<ContentBlock, { type: "image" }>["source"],
	resolveFileRef: ((fileId: string) => string | null) | undefined,
): { data: string; mediaType: string } | null {
	if (source.type === "base64") {
		return { data: source.data, mediaType: source.media_type };
	}
	if (source.type === "file_ref" && resolveFileRef) {
		const data = resolveFileRef(source.file_id);
		if (data) {
			return { data, mediaType: source.media_type ?? "image/jpeg" };
		}
	}
	return null;
}

function imageUnavailablePlaceholder(b: Extract<ContentBlock, { type: "image" }>): string {
	const fileId = b.source.type === "file_ref" ? b.source.file_id : "(inline)";
	const desc = b.description ? ` description=${JSON.stringify(b.description)}` : "";
	return `[Image unavailable: file_id=${fileId}${desc}]`;
}

function documentUnavailablePlaceholder(b: Extract<ContentBlock, { type: "document" }>): string {
	const fileId = b.source.type === "file_ref" ? b.source.file_id : "(inline)";
	const title = b.title ? ` title=${JSON.stringify(b.title)}` : "";
	const filename = b.filename ? ` filename=${JSON.stringify(b.filename)}` : "";
	return `[Document unavailable: file_id=${fileId}${title}${filename}]`;
}

/**
 * Build the AI SDK V2 ToolResultOutput for a tool_result message.
 *
 * The `LanguageModelV2ToolResultOutput` discriminated union supports two
 * shapes we care about here:
 *   - `{ type: "text", value: string }` — single text payload, the common
 *     case for shell/connector/database tools that return strings.
 *   - `{ type: "content", value: Array<{type:"text"} | {type:"media"}> }`
 *     — required to preserve images, which MCP tools (vision-enabled
 *     servers, Discord image fetches, etc.) routinely return alongside
 *     text. Without this shape, the model never sees the image.
 *
 * Strategy:
 *   - If every block is text → keep the simple `{type:"text"}` shape for
 *     back-compat with providers that may treat the two shapes differently.
 *   - If any block is non-text → emit `{type:"content"}` so images and
 *     other media survive the trip to the model.
 *
 * file_ref images and documents route through `resolveFileRef`
 * (defense-in-depth — by the time we reach here, context-assembly's
 * substituteUnsupportedBlocks has typically already resolved them, but we
 * re-resolve so test paths and any future bypass don't cause silent
 * drops). Unresolvable file_refs degrade to `text_representation` when
 * available (documents) or a clear `[… unavailable: …]` placeholder
 * rather than vanishing.
 *
 * Other non-text blocks (thinking, tool_use, nested tool_result) shouldn't
 * appear inside a tool_result by construction, so we serialize them as
 * JSON text to preserve the data without inventing a wire shape.
 */
function buildToolResultOutput(
	blocks: ContentBlock[],
	resolveFileRef?: (fileId: string) => string | null,
):
	| { type: "text"; value: string }
	| {
			type: "content";
			value: Array<
				{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }
			>;
	  } {
	const hasNonText = blocks.some((b) => b.type !== "text");
	if (!hasNonText) {
		return {
			type: "text",
			value: blocks
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(""),
		};
	}

	const items: Array<
		{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }
	> = [];
	for (const b of blocks) {
		if (b.type === "text") {
			items.push({ type: "text", text: b.text });
		} else if (b.type === "image") {
			const resolved = resolveImageSource(b.source, resolveFileRef);
			if (resolved) {
				items.push({
					type: "media",
					data: resolved.data,
					mediaType: resolved.mediaType,
				});
			} else {
				items.push({ type: "text", text: imageUnavailablePlaceholder(b) });
			}
		} else if (b.type === "document") {
			// Documents in tool_result content (e.g. the MCP `resource` path
			// when the tool returns a binary blob persisted as a file_ref)
			// degrade through the same three-tier ladder as user-content
			// documents: base64 → media item, file_ref → resolve+media,
			// otherwise text_representation, otherwise placeholder.
			if (b.source.type === "base64") {
				items.push({
					type: "media",
					data: b.source.data,
					mediaType: b.source.media_type,
				});
			} else if (b.source.type === "file_ref" && resolveFileRef) {
				const data = resolveFileRef(b.source.file_id);
				if (data) {
					items.push({
						type: "media",
						data,
						mediaType: b.source.media_type ?? "application/octet-stream",
					});
				} else if (b.text_representation) {
					items.push({ type: "text", text: b.text_representation });
				} else {
					items.push({ type: "text", text: documentUnavailablePlaceholder(b) });
				}
			} else if (b.text_representation) {
				items.push({ type: "text", text: b.text_representation });
			} else {
				items.push({ type: "text", text: documentUnavailablePlaceholder(b) });
			}
		} else {
			// Defensive: anything else (thinking, tool_use, …) gets
			// JSON-serialized so the data isn't lost. These shouldn't appear
			// inside tool_result content by construction.
			items.push({ type: "text", text: JSON.stringify(b) });
		}
	}
	return { type: "content", value: items };
}

/**
 * Build either an ImagePart (UserContent) or a FilePart (AssistantContent)
 * from an image ContentBlock. AssistantContent in @ai-sdk/provider-utils
 * does not include ImagePart — if an assistant turn carries a generated
 * image, we must route it as FilePart with the image media type, which the
 * SDK accepts.
 *
 * file_ref sources resolve through `resolveFileRef`. When the resolver
 * isn't supplied (e.g., direct unit tests of the bridge) or returns null
 * (file deleted), the function returns null and the caller substitutes a
 * `[Image unavailable: …]` text part so the model is informed — never a
 * silent drop.
 */
function buildImageOrFilePart(
	b: Extract<ContentBlock, { type: "image" }>,
	opts: {
		asFile: boolean;
		resolveFileRef?: (fileId: string) => string | null;
	},
): Record<string, unknown> | null {
	const resolved = resolveImageSource(b.source, opts.resolveFileRef);
	if (!resolved) return null;
	const buf = Uint8Array.from(Buffer.from(resolved.data, "base64"));
	if (opts.asFile) {
		return {
			type: "file",
			data: buf,
			mediaType: resolved.mediaType,
			...(b.description && { filename: b.description }),
		};
	}
	return {
		type: "image",
		image: buf,
		mediaType: resolved.mediaType,
	};
}

/**
 * Build an AI SDK FilePart from a document ContentBlock. Falls back to a
 * text part when only text_representation is available (non-vision/document
 * backends, or providers that don't support the document's media type).
 *
 * Bedrock accepts a wide file set via FilePart (application/pdf,
 * text/plain, text/csv, application/json, text/markdown, text/html, docx,
 * xlsx, etc.) — see @ai-sdk/amazon-bedrock's bedrockFilePartProviderOptions.
 * OpenAI-compatible providers vary; when in doubt, text_representation is
 * the safest wire format and the bridge caller (driver) can override.
 */
/**
 * Resolve a document block to a renderable part.
 *
 * Returns:
 *   - {kind: "file"} when the bytes are available (base64 inline OR file_ref
 *     successfully resolved). Bridges to AI SDK FilePart.
 *   - {kind: "text"} when no bytes are available but a `text_representation`
 *     was provided up-front (text-degraded path).
 *   - null when bytes are unavailable AND no text fallback exists; the
 *     caller emits a `[Document unavailable: …]` placeholder so the model
 *     is informed instead of silently dropping the block.
 *
 * media_type fallback for file_refs: documents may carry a `media_type`
 * hint on the source itself (set when the row was inserted by the MCP
 * resource path or by user upload). When absent we default to
 * application/octet-stream — providers may reject it but that's better
 * than guessing the wrong concrete type.
 */
function buildDocumentPart(
	b: Extract<ContentBlock, { type: "document" }>,
	resolveFileRef: ((fileId: string) => string | null) | undefined,
): Record<string, unknown> | null {
	if (b.source.type === "base64") {
		const buf = Uint8Array.from(Buffer.from(b.source.data, "base64"));
		return {
			type: "file",
			data: buf,
			mediaType: b.source.media_type,
			...(b.filename && { filename: b.filename }),
		};
	}
	if (b.source.type === "file_ref" && resolveFileRef) {
		const data = resolveFileRef(b.source.file_id);
		if (data) {
			const buf = Uint8Array.from(Buffer.from(data, "base64"));
			return {
				type: "file",
				data: buf,
				mediaType: b.source.media_type ?? "application/octet-stream",
				...(b.filename && { filename: b.filename }),
			};
		}
	}
	// file_ref couldn't be resolved (no resolver, or file missing). Prefer
	// the pre-extracted text representation when available — that's the
	// entire point of the field and keeps the path useful for backends
	// without native document support.
	if (b.text_representation) {
		return { type: "text", text: b.text_representation };
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool conversion
// ─────────────────────────────────────────────────────────────────────────────

export function toToolSet(tools?: ToolDefinition[]): ToolSet | undefined {
	if (!tools || tools.length === 0) return undefined;
	const result: ToolSet = {};
	for (const t of tools) {
		result[t.function.name] = aiTool({
			description: t.function.description,
			inputSchema: jsonSchema(t.function.parameters),
		});
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream chunk conversion
// ─────────────────────────────────────────────────────────────────────────────

export interface MapChunksOptions {
	/**
	 * Provider key for usage extraction. Bedrock puts cache-write tokens in
	 * providerMetadata.bedrock.usage.cacheWriteInputTokens; Anthropic puts
	 * them in providerMetadata.anthropic.cacheCreationInputTokens. The metadata
	 * arrives on `finish-step` events (NOT `finish`) — `finish` at the
	 * TextStreamPart layer only carries `finishReason + totalUsage`. We
	 * therefore track the last `finish-step`'s providerMetadata and apply it
	 * when `finish` fires.
	 */
	usageProvider?: "bedrock" | "anthropic" | null;
	/**
	 * Fallback char-based token estimator if the provider reports zero usage
	 * but we did observe output text. Preserves the legacy BedrockDriver
	 * zero-usage guard behavior.
	 */
	estimateInputFromMessages?: LLMMessage[];
}

type ProviderMetadata = Record<string, Record<string, unknown>>;

interface FinishState {
	totalUsage?: {
		inputTokens?: number;
		outputTokens?: number;
		cachedInputTokens?: number;
		reasoningTokens?: number;
		totalTokens?: number;
	};
	providerMetadata?: ProviderMetadata;
}

/**
 * Consume an AI SDK fullStream and yield StreamChunk events.
 *
 * This is the inverse of the old per-driver streaming parsers. The AI SDK
 * normalizes SSE + Bedrock event-stream into a single shape; we translate
 * that shape back into our downstream StreamChunk type.
 *
 * Event shape reference (ai@5.0.179 TextStreamPart, ai/dist/index.d.ts:2213):
 *   - text-delta: { id, text, providerMetadata? }
 *   - reasoning-delta: { id, text, providerMetadata? }
 *       Bedrock emits signatures AND redacted data on this event with
 *       text:"" + providerMetadata.bedrock.{signature|redactedData}. See
 *       @ai-sdk/amazon-bedrock/dist/index.mjs lines 1239-1275.
 *   - tool-input-delta: { id, delta, providerMetadata? }
 *       (NB: `delta` not `text` — different from the text/reasoning deltas)
 *   - finish-step: { response, usage, finishReason, providerMetadata }
 *       Cache-write tokens live here under providerMetadata.bedrock.usage.
 *   - finish: { finishReason, totalUsage }  ← NO providerMetadata
 */
export async function* mapChunks(
	stream: AsyncIterable<unknown>,
	opts: MapChunksOptions = {},
): AsyncIterable<StreamChunk> {
	let outputText = "";
	// Widened "something happened" signal for the zero-usage estimator.
	// Pre-2026-04-26, estimation only kicked in when outputText.length > 0,
	// so tool-only and thinking-only responses (haiku cron turns that just
	// called retrieve_task; qwen3.6 threads that emitted only thinking
	// + tool calls) were recorded with tokens_in=tokens_out=0. We now
	// accumulate reasoning text and tool-input-delta bytes here so those
	// responses get a reasonable char-based estimate.
	// bound_issue:turns-table:observability-gap sub-gap 2b.
	let reasoningText = "";
	let toolInputText = "";
	// Track tool-input-start names since tool-input-delta only carries the id.
	const toolNameById = new Map<string, string>();
	// Accumulate providerMetadata across finish-step events so we have it
	// available when the terminal `finish` fires.
	let lastStepMetadata: ProviderMetadata | undefined;

	for await (const raw of stream) {
		const part = raw as { type: string } & Record<string, unknown>;
		switch (part.type) {
			case "text-delta": {
				const text = (part.text as string | undefined) ?? "";
				if (text) {
					outputText += text;
					yield { type: "text", content: text };
				}
				break;
			}
			case "reasoning-delta": {
				const text = (part.text as string | undefined) ?? "";
				const meta = part.providerMetadata as ProviderMetadata | undefined;
				if (text) {
					reasoningText += text;
					yield { type: "thinking", content: text };
				}
				// Signatures and redacted data arrive on reasoning-delta with
				// empty text. Bedrock puts signature under
				// providerMetadata.bedrock.signature and redacted reasoning
				// under providerMetadata.bedrock.redactedData. Anthropic direct
				// uses providerMetadata.anthropic.signature. Both are emitted as
				// dedicated fields on the thinking chunk — downstream stitches
				// them onto the assembled ContentBlock without string-prefix
				// demuxing.
				const sig =
					(meta?.bedrock?.signature as string | undefined) ??
					(meta?.anthropic?.signature as string | undefined);
				if (sig) yield { type: "thinking", content: "", signature: sig };
				const redacted = meta?.bedrock?.redactedData as string | undefined;
				if (redacted) {
					yield { type: "thinking", content: "", redacted_data: redacted };
				}
				break;
			}
			case "tool-input-start": {
				const id = (part.id as string | undefined) ?? "";
				const name = (part.toolName as string | undefined) ?? "";
				toolNameById.set(id, name);
				// Count the tool name towards output size so a plain
				// tool call without args still gets estimated.
				toolInputText += name;
				yield { type: "tool_use_start", id, name };
				break;
			}
			case "tool-input-delta": {
				const id = (part.id as string | undefined) ?? "";
				const delta = (part.delta as string | undefined) ?? "";
				toolInputText += delta;
				yield { type: "tool_use_args", id, partial_json: delta };
				break;
			}
			case "tool-input-end": {
				const id = (part.id as string | undefined) ?? "";
				yield { type: "tool_use_end", id };
				toolNameById.delete(id);
				break;
			}
			case "finish-step": {
				// Capture per-step providerMetadata so finish can use it.
				const meta = part.providerMetadata as ProviderMetadata | undefined;
				if (meta) lastStepMetadata = meta;
				break;
			}
			case "finish": {
				const totalUsage = part.totalUsage as FinishState["totalUsage"];
				yield {
					type: "done",
					usage: extractUsage(
						{ totalUsage, providerMetadata: lastStepMetadata },
						{ text: outputText, reasoning: reasoningText, toolInput: toolInputText },
						opts,
					),
				};
				break;
			}
			case "error": {
				// AI SDK converts initial request failures (e.g. Bedrock 403
				// AccessDeniedException on converse-stream, 400 invalid-model) into
				// `{ type: "error", error }` events on fullStream — the iterator
				// does NOT reject. Throwing here lets the driver's existing
				// try/catch wrap the thrown value via mapError and the agent-loop
				// catch then flows to the non-retryable alert path, so operators
				// see the failure in logs + as a role:"alert" DB message instead
				// of watching a task quietly complete with zero output tokens.
				const err = part.error;
				const message = err instanceof Error ? err.message : String(err);
				throw err instanceof LLMError
					? err
					: new LLMError(message, "ai-sdk", undefined, err instanceof Error ? err : undefined);
			}
			// start, text-start, text-end, reasoning-start, reasoning-end,
			// tool-call, tool-result, response-metadata, start-step, raw,
			// source, file, abort — intentionally ignored. Our downstream
			// StreamChunk doesn't model them. text-start/end and
			// reasoning-start/end are block-boundary markers we don't need
			// (deltas carry the id); tool-call is redundant after
			// tool-input-end; file/source are upstream surfaces we don't
			// currently consume.
			default:
				break;
		}
	}
}

interface DoneUsage {
	input_tokens: number;
	output_tokens: number;
	cache_write_tokens: number | null;
	cache_read_tokens: number | null;
	estimated: boolean;
}

interface OutputWitness {
	text: string;
	reasoning: string;
	toolInput: string;
}

function extractUsage(
	finish: FinishState,
	output: OutputWitness,
	opts: MapChunksOptions,
): DoneUsage {
	const u = finish.totalUsage ?? {};
	let inputTokens = u.inputTokens ?? 0;
	let outputTokens = u.outputTokens ?? 0;
	const cacheReadTokens = u.cachedInputTokens ?? null;

	// Cache-write tokens aren't part of the standardized usage shape — they
	// live in providerMetadata. Pull per-provider.
	let cacheWriteTokens: number | null = null;
	const meta = finish.providerMetadata;
	if (meta) {
		if (opts.usageProvider === "bedrock") {
			const bedrockUsage = meta.bedrock?.usage as { cacheWriteInputTokens?: number } | undefined;
			cacheWriteTokens = bedrockUsage?.cacheWriteInputTokens ?? null;
		} else if (opts.usageProvider === "anthropic") {
			cacheWriteTokens = (meta.anthropic?.cacheCreationInputTokens as number | undefined) ?? null;
		}
	}

	// Zero-usage guard — widened to cover any observable output, not just
	// text. Responses that only emitted tool calls (haiku cron turns that
	// called retrieve_task) or only thinking (qwen3.6 threads where the
	// model reasoned extensively but produced no text before a tool call)
	// were silently recorded as tokens_in=tokens_out=0, breaking cost/
	// usage accounting per-host. bound_issue:turns-table:observability-gap
	// sub-gap 2b.
	let estimated = false;
	const observableOutput = output.text + output.reasoning + output.toolInput;
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		observableOutput.length > 0 &&
		opts.estimateInputFromMessages
	) {
		inputTokens = Math.ceil(
			opts.estimateInputFromMessages.reduce(
				(sum, m) =>
					sum +
					(typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
				0,
			) / 4,
		);
		outputTokens = Math.ceil(observableOutput.length / 4);
		estimated = true;
	}

	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_write_tokens: cacheWriteTokens,
		cache_read_tokens: cacheReadTokens,
		estimated,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an unknown error from the AI SDK into an LLMError with a best-effort
 * HTTP status code. The ModelRouter relies on statusCode to drive pool
 * backoff (402 / 429 / 5xx). AI SDK errors are tagged classes (APICallError,
 * etc.) — duck-type on .statusCode / .status since we don't want to import
 * every error class.
 */
export function mapError(err: unknown, provider: string): LLMError {
	if (err instanceof LLMError) return err;
	const e = err as
		| {
				statusCode?: number;
				status?: number;
				name?: string;
				message?: string;
				$metadata?: { httpStatusCode?: number };
				responseHeaders?: Record<string, string>;
		  }
		| null
		| undefined;
	const statusCode = e?.statusCode ?? e?.status ?? e?.$metadata?.httpStatusCode;
	const retryAfterHeader =
		e?.responseHeaders?.["retry-after"] ?? e?.responseHeaders?.["Retry-After"];
	const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;
	return new LLMError(
		`${provider} request failed: ${formatError(err)}`,
		provider,
		statusCode,
		err instanceof Error ? err : new Error(String(err)),
		retryAfterMs,
	);
}

function parseRetryAfter(header: string): number | undefined {
	const n = Number(header);
	if (!Number.isNaN(n)) return n * 1000;
	const ts = Date.parse(header);
	if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
	return undefined;
}
