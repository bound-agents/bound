/**
 * Zod schemas for relay payload types. Use with parseJsonSafe() to validate
 * relay payloads at trust boundaries (incoming relay messages, sync responses).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Request payload schemas
// ---------------------------------------------------------------------------

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

export const inferenceRequestPayloadSchema = z.object({
	model: z.string().min(1),
	messages: z.array(z.unknown()),
	tools: z.array(z.unknown()).optional(),
	system: z.string().optional(),
	system_suffix: z.string().optional(),
	max_tokens: z.number().int().positive().optional(),
	temperature: z.number().optional(),
	cache_breakpoints: z.array(z.number()).optional(),
	thinking: z
		.object({
			type: z.literal("enabled"),
			budget_tokens: z.number().int().positive(),
		})
		.optional(),
	messages_file_ref: z.string().optional(),
});

export const processPayloadSchema = z.object({
	thread_id: z.string().min(1),
	message_id: z.string().min(1),
	user_id: z.string().min(1),
	platform: z.string().nullable(),
});

export const intakePayloadSchema = z.object({
	platform: z.string().min(1),
	platform_event_id: z.string(),
	thread_id: z.string().min(1),
	user_id: z.string().min(1),
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

export const platformDeliverPayloadSchema = z.object({
	platform: z.string().min(1),
	thread_id: z.string().min(1),
	message_id: z.string().min(1),
	content: z.string(),
	// attachments contain Buffers and can't be fully validated via Zod
	attachments: z.array(z.unknown()).optional(),
});

export const eventBroadcastPayloadSchema = z.object({
	event_name: z.string().min(1),
	event_payload: z.record(z.string(), z.unknown()),
	source_host: z.string(),
	event_depth: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Response payload schemas
// ---------------------------------------------------------------------------

export const resultPayloadSchema = z.object({
	stdout: z.string(),
	stderr: z.string(),
	exit_code: z.number().int(),
	execution_ms: z.number(),
});

export const errorPayloadSchema = z.object({
	error: z.string(),
	retriable: z.boolean(),
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

// ---------------------------------------------------------------------------
// Host JSON column schemas
// ---------------------------------------------------------------------------

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

export const hostPlatformsSchema = z.array(z.string());

// ---------------------------------------------------------------------------
// Relay kind to schema mapping (for dynamic dispatch)
// ---------------------------------------------------------------------------

export const RELAY_PAYLOAD_SCHEMAS = {
	tool_call: toolCallPayloadSchema,
	resource_read: resourceReadPayloadSchema,
	prompt_invoke: promptInvokePayloadSchema,
	cache_warm: cacheWarmPayloadSchema,
	cancel: cancelPayloadSchema,
	inference: inferenceRequestPayloadSchema,
	process: processPayloadSchema,
	intake: intakePayloadSchema,
	platform_deliver: platformDeliverPayloadSchema,
	event_broadcast: eventBroadcastPayloadSchema,
	result: resultPayloadSchema,
	error: errorPayloadSchema,
	stream_chunk: streamChunkPayloadSchema,
	stream_end: streamEndPayloadSchema,
	status_forward: statusForwardPayloadSchema,
} as const;
