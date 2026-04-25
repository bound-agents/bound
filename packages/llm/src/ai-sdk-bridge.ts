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
import { jsonSchema, tool as aiTool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type {
	ChatParams,
	ContentBlock,
	LLMMessage,
	StreamChunk,
	ToolDefinition,
} from "./types";
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
}

/**
 * Convert Bound's LLMMessage shape to AI SDK ModelMessage.
 *
 * Role mapping:
 *   user       → user
 *   assistant  → assistant
 *   system     → system
 *   developer  → system (AI SDK has no developer role at the input shape;
 *                the OpenAI-compatible provider re-promotes this on the wire
 *                when the upstream model supports it)
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
		const blocks = Array.isArray(msg.content)
			? msg.content
			: normalizeBlocks(msg.content);
		for (const b of blocks) {
			if (b.type === "tool_use") toolNameById.set(b.id, b.name);
		}
	}

	for (const msg of messages) {
		if (msg.role === "cache") {
			// Attach a cache breakpoint to the most recently emitted message.
			const prev = result[result.length - 1];
			if (!prev || !opts.cacheProvider) continue;
			const provOpts = (prev.providerOptions ??= {}) as Record<
				string,
				Record<string, unknown>
			>;
			const bucket = (provOpts[opts.cacheProvider] ??= {});
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
			const text = blocks
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("");
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
						output: { type: "text", value: text },
					},
				] as never,
			});
			continue;
		}

		if (msg.role === "developer") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: extractText(msg.content);
			result.push({ role: "system", content: text });
			continue;
		}

		// user / assistant / system with content blocks
		if (typeof msg.content === "string") {
			result.push({
				role: msg.role as "user" | "assistant" | "system",
				content: msg.content,
			} as ModelMessage);
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
				const imgPart = buildImageOrFilePart(b, { asFile: isAssistant });
				if (imgPart) parts.push(imgPart);
			} else if (b.type === "document") {
				const docPart = buildDocumentPart(b);
				if (docPart) parts.push(docPart);
			}
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

	return result;
}

function normalizeBlocks(content: string | ContentBlock[]): ContentBlock[] {
	if (Array.isArray(content)) return content;
	// DB serializes tool_call/tool_result content as JSON strings of blocks;
	// fall back to treating the string as a single text block if parse fails.
	try {
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed as ContentBlock[];
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
	const providerOptions =
		Object.keys(bedrock).length > 0 ? { bedrock } : undefined;
	return {
		type: "reasoning" as const,
		text: b.thinking,
		...(providerOptions && { providerOptions }),
	};
}

/**
 * Build either an ImagePart (UserContent) or a FilePart (AssistantContent)
 * from an image ContentBlock. AssistantContent in @ai-sdk/provider-utils
 * does not include ImagePart — if an assistant turn carries a generated
 * image, we must route it as FilePart with the image media type, which the
 * SDK accepts.
 *
 * file_ref variants should have been resolved to base64 by context-assembly
 * before reaching the driver. If one slips through, we skip it rather than
 * silently fabricating wrong data — the caller has a bug and a log elsewhere
 * will surface it. Returning `null` lets the caller decide whether to drop
 * the block or emit a placeholder.
 */
function buildImageOrFilePart(
	b: Extract<ContentBlock, { type: "image" }>,
	opts: { asFile: boolean },
): Record<string, unknown> | null {
	if (b.source.type !== "base64") {
		// Contract: context-assembly.resolveFileRefs() runs before the driver.
		// An unresolved file_ref here is a caller bug; log via the returned
		// null and let the caller decide (we log at the driver-shim layer).
		return null;
	}
	const buf = Uint8Array.from(Buffer.from(b.source.data, "base64"));
	if (opts.asFile) {
		return {
			type: "file",
			data: buf,
			mediaType: b.source.media_type,
			...(b.description && { filename: b.description }),
		};
	}
	return {
		type: "image",
		image: buf,
		mediaType: b.source.media_type,
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
function buildDocumentPart(
	b: Extract<ContentBlock, { type: "document" }>,
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
	// file_ref without resolution: fall back to text_representation if
	// available (that's the entire point of the field). Otherwise the
	// block is unsendable.
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
				yield { type: "tool_use_start", id, name };
				break;
			}
			case "tool-input-delta": {
				const id = (part.id as string | undefined) ?? "";
				const delta = (part.delta as string | undefined) ?? "";
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
						outputText,
						opts,
					),
				};
				break;
			}
			case "error": {
				const err = part.error;
				yield {
					type: "error",
					error: err instanceof Error ? err.message : String(err),
				};
				break;
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

function extractUsage(
	finish: FinishState,
	outputText: string,
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
			const bedrockUsage = meta.bedrock?.usage as
				| { cacheWriteInputTokens?: number }
				| undefined;
			cacheWriteTokens = bedrockUsage?.cacheWriteInputTokens ?? null;
		} else if (opts.usageProvider === "anthropic") {
			cacheWriteTokens =
				(meta.anthropic?.cacheCreationInputTokens as number | undefined) ??
				null;
		}
	}

	// Zero-usage guard — matches legacy BedrockDriver behavior.
	let estimated = false;
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		outputText.length > 0 &&
		opts.estimateInputFromMessages
	) {
		inputTokens = Math.ceil(
			opts.estimateInputFromMessages.reduce(
				(sum, m) =>
					sum +
					(typeof m.content === "string"
						? m.content.length
						: JSON.stringify(m.content).length),
				0,
			) / 4,
		);
		outputTokens = Math.ceil(outputText.length / 4);
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
	const statusCode =
		e?.statusCode ?? e?.status ?? e?.$metadata?.httpStatusCode;
	const retryAfterHeader =
		e?.responseHeaders?.["retry-after"] ?? e?.responseHeaders?.["Retry-After"];
	const retryAfterMs = retryAfterHeader
		? parseRetryAfter(retryAfterHeader)
		: undefined;
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
