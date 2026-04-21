/**
 * Structured validation error for Bedrock requests.
 *
 * Thrown by `validateBedrockRequest` when input fails validation. The `code`
 * field is a tagged union so callers (structured logging, alerting, retry
 * layers) can match on specific failure modes without parsing message strings.
 *
 * All validation failures are NON-RETRIABLE — the same malformed input will
 * fail the same way next time. The retry layer in the LLM facade checks
 * `retriable: false` and gives up immediately.
 */

export type BedrockValidationErrorCode =
	// Structural errors — the input shape is fundamentally wrong.
	| "not_an_array"
	| "empty_conversation"
	// Role/order errors.
	| "first_not_user"
	| "last_not_user"
	| "consecutive_same_role"
	// Message-level errors — some field on a specific message is invalid.
	| "invalid_message_shape"
	| "empty_content"
	| "blank_text"
	// Tool-pairing errors — the assistant/user tool dance is off.
	| "tool_result_without_call"
	| "tool_use_id_mismatch"
	| "tool_use_id_empty"
	// Request-level errors.
	| "empty_model_id"
	| "empty_system_block"
	| "temperature_with_thinking"
	| "invalid_tool_name"
	| "invalid_inference_config";

export interface BedrockValidationDetail {
	readonly code: BedrockValidationErrorCode;
	/** Index of the offending message, when applicable. */
	readonly index?: number;
	/** Human-readable description of the specific violation. */
	readonly message: string;
	/** Optional structured context (e.g. expected vs actual tool IDs). */
	readonly context?: Record<string, unknown>;
}

export class BedrockValidationError extends Error {
	readonly name = "BedrockValidationError";
	readonly retriable = false;
	readonly details: readonly BedrockValidationDetail[];

	constructor(details: readonly BedrockValidationDetail[]) {
		const summary = details
			.map((d) => {
				const prefix = d.index !== undefined ? `[msg ${d.index}] ` : "";
				return `${prefix}${d.code}: ${d.message}`;
			})
			.join("; ");
		super(`Bedrock request validation failed: ${summary}`);
		this.details = details;
	}

	/** Convenience: get the first error code, useful for metrics. */
	get primaryCode(): BedrockValidationErrorCode {
		return this.details[0]?.code ?? "invalid_message_shape";
	}
}
