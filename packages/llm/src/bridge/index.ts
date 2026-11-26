/**
 * Shared conversion helpers between Bound's LLM shapes and the Vercel AI SDK.
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
	OPENAI_RESPONSES_ENVELOPE,
	PERMISSIVE_ENVELOPE,
	sanitizeToolNameForEnvelope,
	sanitizeToolUseId,
	toModelMessages,
} from "./messages";
export { type MapChunksOptions, mapChunks } from "./stream";
export { toToolSet } from "./tools";
export { mapError } from "./errors";
export { isResponsesInputRejection, summarizeRequestShape } from "./request-diagnostics";
