import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message, SystemContentBlock, Tool } from "@aws-sdk/client-bedrock-runtime";
import { createLogger, formatError } from "@bound/shared";
import { CryptoHasher } from "bun";
import { toBedrockRequest } from "./bedrock/convert";
import { validateBedrockRequest } from "./bedrock/validate";
import { withRetry } from "./retry";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";
import { LLMError } from "./types";

// --- legacy helper removed: runtime path goes through toBedrockRequest() + ---
// --- validateBedrockRequest(). Tests now import toBedrockMessages from    ---
// --- ./bedrock/convert directly. See 2026-04-21 driver-swap commit.       ---

// ─── Cache-stability debug logging ─────────────────────────────────────────
// Enable with BOUND_DEBUG_BEDROCK_CACHE=1 to emit per-section fingerprints
// of each Bedrock request. Compare consecutive lines to find which section
// is busting the prompt cache.
//
// Set BOUND_DEBUG_BEDROCK_CACHE=full to also dump the complete raw request
// JSON (large — use only for targeted debugging).

const CACHE_DEBUG = process.env.BOUND_DEBUG_BEDROCK_CACHE;
const cacheLog = createLogger("@bound/llm", "bedrock-cache");
let cacheDebugSeq = 0;

/** SHA-256 fingerprint of a JSON-serializable value, truncated to 12 hex chars. */
function fingerprint(value: unknown): string {
	const hasher = new CryptoHasher("sha256");
	hasher.update(stableStringify(value));
	return hasher.digest("hex").slice(0, 12);
}

/**
 * Deterministic JSON serializer that replaces Uint8Array with a placeholder
 * (binary image data is not useful for cache-key comparison and would bloat
 * the output). Object keys are sorted to eliminate insertion-order jitter.
 */
function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val instanceof Uint8Array) return `<Uint8Array:${val.byteLength}>`;
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(val).sort()) sorted[k] = (val as Record<string, unknown>)[k];
			return sorted;
		}
		return val;
	});
}

/**
 * Find the index of the message carrying the cachePoint marker (if any).
 * Returns -1 when no cachePoint is placed.
 */
function findCachePointIndex(messages: unknown[]): number {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as Record<string, unknown>;
		if (Array.isArray(msg.content)) {
			for (const block of msg.content as Array<Record<string, unknown>>) {
				if ("cachePoint" in block) return i;
			}
		}
	}
	return -1;
}

interface CacheDebugEntry {
	seq: number;
	messageCount: number;
	cachePointIdx: number;
	cacheMessageCount: number;
	developerMessageCount: number;
	toolConfigCached: boolean;
	fingerprints: {
		system: string | null;
		prefixMessages: string;
		suffixMessages: string;
		toolConfig: string | null;
		inferenceConfig: string;
		additionalFields: string | null;
		full: string;
	};
}

function emitCacheDebug(raw: {
	modelId: unknown;
	messages: unknown;
	system?: unknown;
	inferenceConfig: unknown;
	additionalModelRequestFields?: unknown;
	toolConfig?: unknown;
}): CacheDebugEntry {
	const seq = ++cacheDebugSeq;
	const messages = Array.isArray(raw.messages) ? raw.messages : [];
	const cpIdx = findCachePointIndex(messages);

	// Count cache marker blocks across all messages
	let cacheMessageCount = 0;
	for (const msg of messages) {
		const msgRecord = msg as Record<string, unknown>;
		if (Array.isArray(msgRecord.content)) {
			for (const block of msgRecord.content as Array<Record<string, unknown>>) {
				if ("cachePoint" in block) {
					cacheMessageCount++;
				}
			}
		}
	}

	// Count developer role messages
	let developerMessageCount = 0;
	for (const msg of messages) {
		const msgRecord = msg as Record<string, unknown>;
		if (msgRecord.role === "developer") {
			developerMessageCount++;
		}
	}

	// Check if toolConfig has cachePoint marker
	const toolConfigCached =
		raw.toolConfig != null &&
		typeof raw.toolConfig === "object" &&
		"cachePoint" in (raw.toolConfig as Record<string, unknown>);

	const prefix = cpIdx >= 0 ? messages.slice(0, cpIdx + 1) : messages;
	const suffix = cpIdx >= 0 ? messages.slice(cpIdx + 1) : [];

	const entry: CacheDebugEntry = {
		seq,
		messageCount: messages.length,
		cachePointIdx: cpIdx,
		cacheMessageCount,
		developerMessageCount,
		toolConfigCached,
		fingerprints: {
			system: raw.system != null ? fingerprint(raw.system) : null,
			prefixMessages: fingerprint(prefix),
			suffixMessages: fingerprint(suffix),
			toolConfig: raw.toolConfig != null ? fingerprint(raw.toolConfig) : null,
			inferenceConfig: fingerprint(raw.inferenceConfig),
			additionalFields:
				raw.additionalModelRequestFields != null
					? fingerprint(raw.additionalModelRequestFields)
					: null,
			full: fingerprint(raw),
		},
	};

	// Log at info level — these only fire when BOUND_DEBUG_BEDROCK_CACHE is
	// explicitly set, so the env var IS the gate. Using debug() here would
	// require LOG_LEVEL=debug too, which is a double-gate nobody will remember.
	cacheLog.info("cache fingerprints", {
		seq,
		messageCount: messages.length,
		cachePointIdx: cpIdx,
		cacheMessageCount,
		developerMessageCount,
		toolConfigCached,
		...entry.fingerprints,
	});

	if (CACHE_DEBUG === "full") {
		cacheLog.info("raw request", { seq, raw: stableStringify(raw) });
	}

	return entry;
}

/** Exported for testing. */
export { fingerprint, stableStringify, findCachePointIndex, emitCacheDebug };
export type { CacheDebugEntry };

export class BedrockDriver implements LLMBackend {
	private client: BedrockRuntimeClient;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		region: string;
		model: string;
		contextWindow: number;
		profile?: string;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		this.client = new BedrockRuntimeClient({
			region: config.region,
			...(config.profile && { profile: config.profile }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Airlock: shape the request, then hand it to the validator. Any
		// invariant violation throws BedrockValidationError here, before any
		// HTTP call. This replaces what used to be a mix of inline assembly
		// and hope.
		const raw = toBedrockRequest({ params, defaultModel: this.model });
		if (CACHE_DEBUG) emitCacheDebug(raw);
		const validated = validateBedrockRequest(raw);

		// The validated shape is structurally compatible with ConverseStreamCommand's
		// input; the brand is a compile-time marker, not a runtime difference.
		// Spread into a plain object to satisfy the SDK's looser types.
		const command = new ConverseStreamCommand({
			modelId: validated.modelId,
			messages: validated.messages as unknown as Message[],
			...(validated.system && { system: validated.system as unknown as SystemContentBlock[] }),
			...(validated.toolConfig && {
				toolConfig: validated.toolConfig as unknown as { tools: Tool[] },
			}),
			inferenceConfig: {
				...(validated.inferenceConfig.thinking === false &&
					validated.inferenceConfig.temperature !== undefined && {
						temperature: validated.inferenceConfig.temperature,
					}),
				...(validated.inferenceConfig.maxTokens !== undefined && {
					maxTokens: validated.inferenceConfig.maxTokens,
				}),
			},
			...(validated.additionalModelRequestFields && {
				additionalModelRequestFields: validated.additionalModelRequestFields as unknown as Record<
					string,
					unknown
				>,
			}),
		} as ConstructorParameters<typeof ConverseStreamCommand>[0]);

		const response = await withRetry(async () => {
			let res: ConverseStreamCommandOutput;
			try {
				res = await this.client.send(command, {
					abortSignal: params.signal,
				});
			} catch (error) {
				// Extract HTTP status from AWS SDK $metadata when available
				const metadata = (error as Record<string, unknown>)?.$metadata as
					| { httpStatusCode?: number }
					| undefined;
				const statusCode = metadata?.httpStatusCode;
				throw new LLMError(
					`Bedrock request failed: ${formatError(error)}`,
					"bedrock",
					statusCode,
					error instanceof Error ? error : new Error(String(error)),
				);
			}

			if (!res.stream) {
				throw new LLMError("Bedrock response contained no stream", "bedrock");
			}

			return res;
		});

		// Track which content block index is a tool use so we can emit tool_use_end
		// when the corresponding contentBlockStop arrives.
		const toolUseIndexToId = new Map<number, string>();
		let outputText = "";

		try {
			// biome-ignore lint/style/noNonNullAssertion: stream existence already checked above
			for await (const event of response.stream!) {
				if (event.messageStart) {
					// Yield heartbeat to reset the silence timeout timer.
					// messageStart arrives early in the stream, before the model
					// starts producing content (thinking/text). Without this,
					// extended thinking can cause 60s+ gaps before the first
					// content chunk, triggering false silence timeouts.
					yield { type: "heartbeat" };
				} else if (event.contentBlockStart) {
					const { contentBlockIndex, start } = event.contentBlockStart;
					if (start?.toolUse) {
						const { toolUseId, name } = start.toolUse;
						const id = toolUseId ?? "";
						toolUseIndexToId.set(contentBlockIndex ?? 0, id);
						yield { type: "tool_use_start", id, name: name ?? "" };
					}
					// Note: Bedrock Converse does NOT emit contentBlockStart for
					// reasoning blocks. Reasoning shows up purely as contentBlockDelta
					// events with delta.reasoningContent, and no tracking flag is
					// needed — the delta shape itself is the discriminator.
				} else if (event.contentBlockDelta) {
					const { contentBlockIndex, delta } = event.contentBlockDelta;
					const deltaRecord = delta as unknown as Record<string, unknown> | undefined;
					// Reasoning deltas. Per the Bedrock Converse stream spec:
					//   delta.reasoningContent: { text?, signature?, redactedContent? }
					// Text and signature arrive as separate deltas on the same block.
					// Redacted content is a Uint8Array we pass through as a
					// thinking chunk with empty content and no signature (the
					// downstream assembler preserves the raw bytes via a
					// different path — for now we just signal a thinking tick).
					const reasoning = deltaRecord?.reasoningContent as
						| { text?: string; signature?: string; redactedContent?: Uint8Array }
						| undefined;
					if (reasoning !== undefined) {
						if (reasoning.signature) {
							yield { type: "thinking", content: "", signature: reasoning.signature };
						} else if (reasoning.text !== undefined) {
							yield { type: "thinking", content: reasoning.text };
						}
					} else if (delta?.text !== undefined) {
						outputText += delta.text;
						yield { type: "text", content: delta.text };
					} else if (delta?.toolUse) {
						const id = toolUseIndexToId.get(contentBlockIndex ?? 0) ?? "";
						yield { type: "tool_use_args", id, partial_json: delta.toolUse.input ?? "" };
					}
				} else if (event.contentBlockStop) {
					const { contentBlockIndex } = event.contentBlockStop;
					const id = toolUseIndexToId.get(contentBlockIndex ?? 0);
					if (id !== undefined) {
						yield { type: "tool_use_end", id };
						toolUseIndexToId.delete(contentBlockIndex ?? 0);
					}
				} else if (event.metadata) {
					const usage = event.metadata.usage as Record<string, unknown> | undefined;
					let inputTokens = (usage?.inputTokens as number) ?? 0;
					let outputTokens = (usage?.outputTokens as number) ?? 0;
					const cw = usage?.cacheWriteInputTokens; // NOTE: "Tokens" not "Count" per AWS API
					const cr = usage?.cacheReadInputTokens; // NOTE: "Tokens" not "Count" per AWS API
					const cacheWriteTokens = typeof cw === "number" ? cw : null;
					const cacheReadTokens = typeof cr === "number" ? cr : null;

					// Zero-usage guard
					let estimated = false;
					if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
						inputTokens = Math.ceil(
							params.messages.reduce(
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
					yield {
						type: "done",
						usage: {
							input_tokens: inputTokens,
							output_tokens: outputTokens,
							cache_write_tokens: cacheWriteTokens,
							cache_read_tokens: cacheReadTokens,
							estimated,
						},
					};
				}
			}
		} catch (error) {
			throw new LLMError(
				`Bedrock stream error: ${formatError(error)}`,
				"bedrock",
				undefined,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			extended_thinking: true,
			max_context: this.contextWindow,
		};
	}
}
