/**
 * Zod schemas for relay payload types. Use with parseJsonSafe() to validate
 * relay payloads at trust boundaries (incoming relay messages, sync responses).
 */
import { z } from "zod";

export const toolCallPayloadSchema = z.object({
	tool: z.string().min(1),
	args: z.record(z.string(), z.unknown()),
	timeout_ms: z.number().int().positive(),
});

export const resourceReadPayloadSchema = z.object({
	resource_uri: z.string().min(1),
	timeout_ms: z.number().int().positive(),
});

export const promptInvokePayloadSchema = z.object({
	prompt_name: z.string().min(1),
	prompt_args: z.record(z.string(), z.unknown()),
	timeout_ms: z.number().int().positive(),
});

export const cacheWarmPayloadSchema = z.object({
	paths: z.array(z.string()),
	timeout_ms: z.number().int().positive(),
});

export const cancelPayloadSchema = z.object({
	ref_id: z.string().min(1),
	reason: z.string().optional(),
});

export const clientToolPayloadSchema = z.object({
	thread_id: z.string().min(1),
	call_id: z.string().min(1),
	tool_name: z.string().min(1),
	args: z.record(z.string(), z.unknown()),
	timeout_ms: z.number().int().positive(),
});

export const clientResultPayloadSchema = z.object({
	call_id: z.string().min(1),
	content: z.string(),
	is_error: z.boolean(),
});

/**
 * The single delegation wire representation (R-UD3). Mirrors the `ContextSegment`
 * type in types.ts. A delegated inference payload carries `segments` instead of
 * raw `messages`: zero or more `inline` segments plus AT MOST ONE `range` segment
 * over the confirmed-synced history prefix. There is no `messages_file_ref` — a
 * range-pointer is kilobytes regardless of token count, so the >2MB files-table
 * offload race is removed, not relocated.
 */
export const contextSegmentSchema = z.union([
	z.object({ kind: z.literal("inline"), message: z.unknown() }),
	z.object({
		kind: z.literal("range"),
		thread_id: z.string().min(1),
		anchor_created_at: z.string().min(1),
		count: z.number().int().nonnegative(),
	}),
]);

export const inferenceRequestPayloadSchema = z.object({
	model: z.string().min(1),
	/**
	 * The delegated context as segments (R-UD3). The consumer resolves these via
	 * `resolveSegments` and NEVER re-assembles — it has no AssemblyAuthority.
	 */
	segments: z.array(contextSegmentSchema),
	/**
	 * The producer's AssemblyClock instant (epoch ms). The consumer threads this
	 * into the annotator when resolving range segments so the `<user-message
	 * sent="…">` year branch reproduces the producer's bytes exactly (R-UD4).
	 */
	nowMs: z.number().int().nonnegative(),
	tools: z.array(z.unknown()).optional(),
	system: z.string().optional(),
	max_tokens: z.number().int().positive().optional(),
	temperature: z.number().optional(),
	// Mirrors ChatParams.top_p — nucleus-sampling cutoff, forwarded verbatim.
	top_p: z.number().optional(),
	// Mirrors ChatParams.tool_choice — AI-SDK-neutral tool-selection strategy.
	// Only meaningful alongside `tools`; the executing driver omits it when no
	// tools are present.
	tool_choice: z
		.union([
			z.literal("auto"),
			z.literal("none"),
			z.literal("required"),
			z.object({ type: z.literal("tool"), toolName: z.string() }),
		])
		.optional(),
	// Mirrors ChatParams.thinking in @bound/llm — both the legacy
	// `{type:"enabled", budget_tokens}` shape (pre-4.7) and the adaptive
	// shape (Opus 4.6+, required on 4.7) are supported over the wire.
	thinking: z
		.union([
			z.object({
				type: z.literal("enabled"),
				budget_tokens: z.number().int().positive(),
			}),
			z.object({
				type: z.literal("adaptive"),
				display: z.enum(["omitted", "summarized"]).optional(),
			}),
		])
		.optional(),
	// Free-form, provider-validated (see ChatParams.effort) — forwarded verbatim
	// over the relay so a hub-delegated turn carries whatever level the caller
	// chose; the executing host's driver validates/maps it.
	effort: z.string().min(1).optional(),
	cache_ttl: z.enum(["5m", "1h"]).optional(),
});

export const intakePayloadSchema = z.object({
	platform: z.string().min(1),
	platform_event_id: z.string(),
	thread_id: z.string().min(1),
	message_id: z.string().min(1),
	content: z.string(),
	attachments: z
		.array(
			z.object({
				filename: z.string(),
				content_type: z.string(),
				size: z.number(),
				url: z.string(),
				description: z.string().optional(),
			}),
		)
		.optional(),
});

export const resultPayloadSchema = z.object({
	stdout: z.string(),
	stderr: z.string(),
	exit_code: z.number().int(),
	execution_ms: z.number(),
});

export const errorPayloadSchema = z.object({
	error: z.string(),
	retriable: z.boolean(),
	// True when the hub or originator can attest that the target tool DEFINITELY
	// did not execute (e.g. hub fast-fail because target spoke was offline). The
	// agent loop uses this to retry safely regardless of tool idempotency.
	// Defaults to undefined/false — full timeouts and target-side errors leave
	// it unset because the target may have started executing before the failure.
	definitely_not_executed: z.boolean().optional(),
});

export const streamChunkPayloadSchema = z.object({
	content: z.string().optional(),
	thinking: z.string().optional(),
	tool_use_start: z
		.object({
			id: z.string(),
			name: z.string(),
		})
		.optional(),
	tool_use_args: z.string().optional(),
	tool_use_end: z.boolean().optional(),
});

export const streamEndPayloadSchema = z.object({
	usage: z.object({
		input_tokens: z.number(),
		output_tokens: z.number(),
		cache_write_tokens: z.number().nullable().optional(),
		cache_read_tokens: z.number().nullable().optional(),
	}),
});

export const statusForwardPayloadSchema = z.object({
	thread_id: z.string(),
	status: z.string(),
	detail: z.string().nullable(),
	tokens: z.number(),
});

export const hostModelsSchema = z.union([
	z.array(z.string()),
	z.array(
		z.object({
			id: z.string().min(1),
			tier: z.number().int().optional(),
			capabilities: z
				.object({
					streaming: z.boolean().optional(),
					tool_use: z.boolean().optional(),
					system_prompt: z.boolean().optional(),
					prompt_caching: z.boolean().optional(),
					vision: z.boolean().optional(),
					max_context: z.number().int().positive().optional(),
				})
				.optional(),
		}),
	),
]);

export const hostMcpToolsSchema = z.array(z.string());

export const platformRequestPayloadSchema = z.object({
	server_name: z.string().min(1),
	method: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
	timeout_ms: z.number().int().positive(),
});

export const hostPlatformsSchema = z.array(z.string());

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket stream chunk schema (discriminated union matching StreamChunk from
// @bound/llm). Heartbeats are filtered upstream and never reach the WS.
// ─────────────────────────────────────────────────────────────────────────────

export const wsStreamChunkSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), content: z.string() }),
	z.object({
		type: z.literal("thinking"),
		content: z.string(),
		signature: z.string().optional(),
		redacted_data: z.string().optional(),
	}),
	z.object({ type: z.literal("tool_use_start"), id: z.string(), name: z.string() }),
	z.object({ type: z.literal("tool_use_args"), id: z.string(), partial_json: z.string() }),
	z.object({ type: z.literal("tool_use_end"), id: z.string() }),
	z.object({
		type: z.literal("done"),
		usage: z.object({
			input_tokens: z.number(),
			output_tokens: z.number(),
			cache_write_tokens: z.number().nullable(),
			cache_read_tokens: z.number().nullable(),
			estimated: z.boolean(),
		}),
		cost_usd: z.number().optional(),
	}),
	z.object({ type: z.literal("error"), error: z.string() }),
]);

export type WsStreamChunk = z.infer<typeof wsStreamChunkSchema>;

export const RELAY_PAYLOAD_SCHEMAS = {
	tool_call: toolCallPayloadSchema,
	resource_read: resourceReadPayloadSchema,
	prompt_invoke: promptInvokePayloadSchema,
	cache_warm: cacheWarmPayloadSchema,
	platform_request: platformRequestPayloadSchema,
	cancel: cancelPayloadSchema,
	inference: inferenceRequestPayloadSchema,
	intake: intakePayloadSchema,
	client_tool: clientToolPayloadSchema,
	result: resultPayloadSchema,
	error: errorPayloadSchema,
	client_result: clientResultPayloadSchema,
	stream_chunk: streamChunkPayloadSchema,
	stream_end: streamEndPayloadSchema,
	status_forward: statusForwardPayloadSchema,
} as const;
