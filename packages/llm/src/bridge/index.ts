/**
 * Shared conversion helpers between Bound's LLM shapes and the Vercel AI SDK.
 *
 * The driver layer used to be ~2400 lines of hand-rolled message assembly,
 * streaming parsers, and provider-specific quirk handling. It now lives here
 * plus the thin driver shims under `../drivers`.
 *
 * Responsibilities, split by module:
 *   - messages.ts: toModelMessages (LLMMessage[] → ModelMessage[]), the wire
 *     envelopes, and tool_use id/name sanitizers.
 *   - tools.ts: toToolSet (ToolDefinition[] → ToolSet) via jsonSchema().
 *   - stream.ts: mapChunks (AI SDK fullStream → StreamChunk) + usage extraction.
 *   - errors.ts: mapError (unknown → LLMError with HTTP status extraction).
 *
 * Provider-specific behavior (cache control, reasoning config, etc.) is
 * injected by the caller via providerOptions — see the individual drivers.
 */

export {
	ANTHROPIC_ENVELOPE,
	BEDROCK_PERMISSIVE_ENVELOPE,
	MAX_TOOL_USE_ID_LENGTH,
	PERMISSIVE_ENVELOPE,
	type ToModelMessagesOptions,
	type WireEnvelope,
	sanitizeToolNameForEnvelope,
	sanitizeToolUseId,
	toModelMessages,
} from "./messages";
export { type MapChunksOptions, mapChunks } from "./stream";
export { toToolSet } from "./tools";
export { mapError } from "./errors";
