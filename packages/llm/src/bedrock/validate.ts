/**
 * The validator — the airlock between raw/untrusted input and the Bedrock
 * driver's HTTP path.
 *
 * Philosophy:
 *   - Input is `unknown`. Nothing is assumed.
 *   - Output is `BedrockValidatedRequest`. The brand carries the proof.
 *   - The body walks the structure with zod-backed type guards and narrows as
 *     it goes, so the validator's own code is type-checked against the
 *     invariants it claims to establish. If `isUserMessage` returns true but
 *     we push something non-UserMessage onto a `UserMessage[]` accumulator, TS
 *     refuses the diff.
 *
 * All failures produce a `BedrockValidationError` with `retriable: false` and
 * a structured list of `BedrockValidationDetail`s. The LLM retry layer treats
 * non-retriable errors as terminal.
 */

import {
	type BedrockValidationDetail,
	BedrockValidationError,
	type BedrockValidationErrorCode,
} from "./errors";
import {
	type AssistantMessage,
	AssistantMessageSchema,
	type InferenceConfig,
	InferenceConfigSchema,
	type PerformanceConfig,
	PerformanceConfigSchema,
	type SystemBlock,
	SystemBlockSchema,
	type ToolName,
	ToolNameSchema,
	type UserMessage,
	UserMessageSchema,
	type ValidatedMessage,
} from "./schemas";
import type { BedrockValidatedConversation, BedrockValidatedRequest } from "./validated-types";

// ─── Type guards backed by zod schemas ──────────────────────────────────────
//
// Each guard uses z.safeParse to run the full runtime check, and narrows the
// TS type on success. If a schema changes shape, the guard's narrowing
// changes with it, because both flow from z.infer on the same schema.

function isUserMessage(x: unknown): x is UserMessage {
	return UserMessageSchema.safeParse(x).success;
}

function isAssistantMessage(x: unknown): x is AssistantMessage {
	return AssistantMessageSchema.safeParse(x).success;
}

function isValidatedMessage(x: unknown): x is ValidatedMessage {
	return isUserMessage(x) || isAssistantMessage(x);
}

function isSystemBlock(x: unknown): x is SystemBlock {
	return SystemBlockSchema.safeParse(x).success;
}

function isInferenceConfig(x: unknown): x is InferenceConfig {
	return InferenceConfigSchema.safeParse(x).success;
}

function isToolName(x: unknown): x is ToolName {
	return ToolNameSchema.safeParse(x).success;
}

// ─── Detail builders ────────────────────────────────────────────────────────

function detail(
	code: BedrockValidationErrorCode,
	message: string,
	opts: { index?: number; context?: Record<string, unknown> } = {},
): BedrockValidationDetail {
	return { code, message, index: opts.index, context: opts.context };
}

// ─── Raw (pre-validation) request shape ─────────────────────────────────────

/**
 * The shape that `toBedrockRequest` (converter) produces and the validator
 * accepts as input. All fields are loosely typed on purpose — the validator
 * is what tightens them.
 */
export interface RawBedrockRequest {
	modelId: unknown;
	messages: unknown;
	system?: unknown;
	inferenceConfig: unknown;
	performanceConfig?: unknown;
	toolConfig?: unknown;
}

// ─── Validator entry point ──────────────────────────────────────────────────

/**
 * Validate a raw Bedrock request. On success returns a branded
 * `BedrockValidatedRequest`. On failure throws a `BedrockValidationError` with
 * every violation found (we accumulate errors rather than fail-fast, so a
 * single validator run surfaces all problems at once).
 */
export function validateBedrockRequest(raw: RawBedrockRequest): BedrockValidatedRequest {
	const errors: BedrockValidationDetail[] = [];

	// ── modelId ─────────────────────────────────────────────────────────────
	if (typeof raw.modelId !== "string" || raw.modelId.length === 0) {
		errors.push(detail("empty_model_id", "modelId must be a non-empty string"));
	}
	const modelId = typeof raw.modelId === "string" ? raw.modelId : "";

	// ── messages: array + per-message shape + alternation ───────────────────
	const validatedMessages = validateMessages(raw.messages, errors);

	// ── system blocks (optional) ────────────────────────────────────────────
	const validatedSystem = validateSystem(raw.system, errors);

	// ── inferenceConfig ─────────────────────────────────────────────────────
	let validatedInference: InferenceConfig | undefined;
	if (isInferenceConfig(raw.inferenceConfig)) {
		validatedInference = raw.inferenceConfig;
	} else {
		const parsed = InferenceConfigSchema.safeParse(raw.inferenceConfig);
		errors.push(
			detail(
				"invalid_inference_config",
				`inferenceConfig failed validation: ${parsed.success ? "unknown" : parsed.error.message}`,
			),
		);
	}

	// ── toolConfig (optional) ───────────────────────────────────────────────
	const validatedToolConfig = validateToolConfig(raw.toolConfig, errors);

	// ── performanceConfig (optional, thinking-only) ─────────────────────────
	let validatedPerformance: PerformanceConfig | undefined;
	if (raw.performanceConfig !== undefined && raw.performanceConfig !== null) {
		const parsed = PerformanceConfigSchema.safeParse(raw.performanceConfig);
		if (parsed.success) {
			validatedPerformance = parsed.data;
			// Cross-invariant: performanceConfig.thinking requires inferenceConfig.thinking=true.
			// If inferenceConfig hasn't validated yet, defer — the main error set will catch it.
			if (validatedInference && validatedInference.thinking !== true) {
				errors.push(
					detail(
						"temperature_with_thinking",
						"performanceConfig.thinking set but inferenceConfig.thinking is false; these must agree",
					),
				);
			}
		} else {
			errors.push(
				detail(
					"invalid_inference_config",
					`performanceConfig failed validation: ${parsed.error.message}`,
				),
			);
		}
	}

	// ── tool_use ↔ tool_result pairing (runtime-only invariant) ─────────────
	// This can't be expressed in TS — the IDs are string-equal runtime values.
	// Check after per-message validation so we know the messages are at least
	// structurally sound.
	if (errors.length === 0) {
		checkToolPairing(validatedMessages, errors);
	}

	if (errors.length > 0) {
		throw new BedrockValidationError(errors);
	}

	// All checks passed — construct the branded output.
	// The `as` casts here are safe: the validator just proved each invariant.
	const brandedMessages = validatedMessages as unknown as BedrockValidatedConversation;

	return {
		modelId,
		messages: brandedMessages,
		system: validatedSystem,
		// biome-ignore lint/style/noNonNullAssertion: errors would have accumulated above if undefined
		inferenceConfig: validatedInference!,
		performanceConfig: validatedPerformance,
		toolConfig: validatedToolConfig,
	};
}

// ─── Messages-level checks ──────────────────────────────────────────────────

/**
 * Walk a candidate messages array, narrowing each element via type guards and
 * checking the conversation-level invariants (starts-with-user,
 * ends-with-user, alternating roles).
 *
 * Returns the narrowed `ValidatedMessage[]` when shape is good enough to
 * continue with. Errors are pushed into the caller's accumulator.
 */
function validateMessages(raw: unknown, errors: BedrockValidationDetail[]): ValidatedMessage[] {
	if (!Array.isArray(raw)) {
		errors.push(detail("not_an_array", "messages must be an array"));
		return [];
	}

	if (raw.length === 0) {
		errors.push(detail("empty_conversation", "messages must not be empty"));
		return [];
	}

	// Narrow element-by-element. The accumulator is typed `ValidatedMessage[]`,
	// so pushing a non-narrowed value would fail to compile. That's the point
	// of doing this inline rather than via a single .safeParse on the array.
	const narrowed: ValidatedMessage[] = [];
	for (let i = 0; i < raw.length; i++) {
		const msg = raw[i];
		if (!isValidatedMessage(msg)) {
			// Re-run one of the schemas to produce a useful error.
			const userResult = UserMessageSchema.safeParse(msg);
			const assistantResult = AssistantMessageSchema.safeParse(msg);
			const reason =
				!userResult.success && !assistantResult.success
					? `role/content invalid (user check: ${userResult.error.message.slice(0, 100)}; assistant check: ${assistantResult.error.message.slice(0, 100)})`
					: "unknown shape";
			errors.push(
				detail("invalid_message_shape", reason, {
					index: i,
					context: {
						role: typeof msg === "object" && msg !== null && "role" in msg ? msg.role : null,
					},
				}),
			);
			continue;
		}
		narrowed.push(msg);
	}

	if (narrowed.length === 0) {
		// Every message failed shape; don't bother with ordering checks.
		return narrowed;
	}

	// First-is-user.
	if (narrowed[0].role !== "user") {
		errors.push(
			detail("first_not_user", `first message must be role=user, got role=${narrowed[0].role}`, {
				index: 0,
			}),
		);
	}

	// Last-is-user.
	const last = narrowed[narrowed.length - 1];
	if (last.role !== "user") {
		errors.push(
			detail("last_not_user", `last message must be role=user, got role=${last.role}`, {
				index: narrowed.length - 1,
			}),
		);
	}

	// Strict alternation.
	for (let i = 1; i < narrowed.length; i++) {
		if (narrowed[i].role === narrowed[i - 1].role) {
			errors.push(
				detail(
					"consecutive_same_role",
					`message at index ${i} has role=${narrowed[i].role}, same as previous`,
					{ index: i },
				),
			);
		}
	}

	// Blank-text check (zod's NonEmptyString should catch this, but only for
	// text blocks; we re-check at this level to surface a cleaner error.)
	for (let i = 0; i < narrowed.length; i++) {
		const m = narrowed[i];
		for (const block of m.content) {
			if ("text" in block && block.text.trim().length === 0) {
				errors.push(
					detail("blank_text", `message at index ${i} contains a blank text block`, {
						index: i,
					}),
				);
				break;
			}
		}
	}

	return narrowed;
}

// ─── System-blocks check ────────────────────────────────────────────────────

function validateSystem(
	raw: unknown,
	errors: BedrockValidationDetail[],
): readonly SystemBlock[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw)) {
		errors.push(detail("empty_system_block", "system must be an array if provided"));
		return undefined;
	}
	const out: SystemBlock[] = [];
	for (let i = 0; i < raw.length; i++) {
		const block = raw[i];
		if (!isSystemBlock(block)) {
			errors.push(detail("empty_system_block", `system block at index ${i} is invalid or empty`));
			continue;
		}
		out.push(block);
	}
	return out.length > 0 ? out : undefined;
}

// ─── Tool-config check ──────────────────────────────────────────────────────

interface ValidatedToolConfig {
	readonly tools: readonly {
		readonly toolSpec: {
			readonly name: ToolName;
			readonly description: string;
			readonly inputSchema: { readonly json: Record<string, unknown> };
		};
	}[];
}

function validateToolConfig(
	raw: unknown,
	errors: BedrockValidationDetail[],
): ValidatedToolConfig | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (
		typeof raw !== "object" ||
		!("tools" in raw) ||
		!Array.isArray((raw as { tools: unknown }).tools)
	) {
		errors.push(
			detail("invalid_tool_name", "toolConfig.tools must be an array if toolConfig is provided"),
		);
		return undefined;
	}
	const tools = (raw as { tools: unknown[] }).tools;
	// Mutable accumulator; we cast to the readonly shape at return time.
	const validated: {
		readonly toolSpec: {
			readonly name: ToolName;
			readonly description: string;
			readonly inputSchema: { readonly json: Record<string, unknown> };
		};
	}[] = [];
	for (let i = 0; i < tools.length; i++) {
		const t = tools[i];
		if (
			typeof t !== "object" ||
			t === null ||
			!("toolSpec" in t) ||
			typeof (t as { toolSpec: unknown }).toolSpec !== "object"
		) {
			errors.push(detail("invalid_tool_name", `tool at index ${i} missing toolSpec`));
			continue;
		}
		const spec = (t as { toolSpec: Record<string, unknown> }).toolSpec;
		if (!isToolName(spec.name)) {
			errors.push(
				detail(
					"invalid_tool_name",
					`tool at index ${i} has invalid name: must match ^[a-zA-Z0-9_-]{1,64}$, got ${JSON.stringify(spec.name)}`,
				),
			);
			continue;
		}
		if (typeof spec.description !== "string") {
			errors.push(detail("invalid_tool_name", `tool at index ${i} missing string description`));
			continue;
		}
		if (
			typeof spec.inputSchema !== "object" ||
			spec.inputSchema === null ||
			!("json" in spec.inputSchema)
		) {
			errors.push(detail("invalid_tool_name", `tool at index ${i} missing inputSchema.json`));
			continue;
		}
		validated.push({
			toolSpec: {
				name: spec.name,
				description: spec.description,
				inputSchema: {
					json: (spec.inputSchema as { json: Record<string, unknown> }).json,
				},
			},
		});
	}
	return { tools: validated };
}

// ─── Tool-use / tool-result pairing ─────────────────────────────────────────

/**
 * Enforce Bedrock's tool-dance invariant:
 *
 *   - Every assistant `toolUse` block must be answered by a `toolResult` block
 *     in the immediately-following user message.
 *   - The set of toolUseIds in a user message's toolResult blocks must match
 *     the set in the preceding assistant's toolUse blocks (no orphans, no
 *     extras).
 *
 * Can't be expressed in TS without dependent types — the check is runtime-only.
 */
function checkToolPairing(
	messages: readonly ValidatedMessage[],
	errors: BedrockValidationDetail[],
): void {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "assistant") continue;

		const toolUseIds = m.content
			.filter((b): b is Extract<typeof b, { toolUse: unknown }> => "toolUse" in b)
			.map((b) => b.toolUse.toolUseId);

		if (toolUseIds.length === 0) continue;

		const next = messages[i + 1];
		if (!next || next.role !== "user") {
			errors.push(
				detail(
					"tool_result_without_call",
					`assistant message at index ${i} has ${toolUseIds.length} toolUse(s) but no following user message with toolResults`,
					{ index: i, context: { expectedToolUseIds: toolUseIds } },
				),
			);
			continue;
		}

		const toolResultIds = next.content
			.filter((b): b is Extract<typeof b, { toolResult: unknown }> => "toolResult" in b)
			.map((b) => b.toolResult.toolUseId);

		if (toolResultIds.some((id) => id.length === 0)) {
			errors.push(
				detail(
					"tool_use_id_empty",
					`user message at index ${i + 1} has an empty toolUseId in toolResult`,
					{ index: i + 1 },
				),
			);
		}

		const useSet = new Set(toolUseIds);
		const resultSet = new Set(toolResultIds);
		const missing = [...useSet].filter((id) => !resultSet.has(id));
		const extra = [...resultSet].filter((id) => !useSet.has(id));

		if (missing.length > 0 || extra.length > 0) {
			errors.push(
				detail(
					"tool_use_id_mismatch",
					`tool IDs between assistant message ${i} and user message ${i + 1} don't match: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
					{
						index: i + 1,
						context: {
							expected: toolUseIds,
							actual: toolResultIds,
							missing,
							extra,
						},
					},
				),
			);
		}
	}
}
