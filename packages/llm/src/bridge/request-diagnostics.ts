/**
 * Privacy-safe request-shape diagnostics for the OpenAI Responses path.
 *
 * The reported incident is an OpenAI Responses API HTTP 400 request-body
 * rejection — `Invalid 'input': value did not match any expected variant`.
 * It fires at the provider wire AFTER the AI SDK's local `validatePrompt`
 * passes and AFTER `convertToOpenAIResponsesInput` serializes the
 * `ModelMessage[]` into the Responses `input` union. The serialized `input`
 * item that failed is not recoverable from any persisted record (confirmed:
 * no historical logs), so when such a rejection surfaces we emit a structural
 * summary of the `LLMMessage[]` that produced the request — enough to
 * identify the failing message/input-item kinds, roles, tool-result output
 * forms, and stable identifiers/counts.
 *
 * This is distinct from commit ea5fe256 (`emit ai@7 file items for
 * tool_result media`), which fixed a LOCAL `validatePrompt`/InvalidPromptError
 * failure in the bridge BEFORE any HTTP call. That shape (`{type:"file",
 * data:{type:"data",…}}`) is well-formed for the Responses converter, so the
 * wire rejection targeted here is a different failure at a later boundary.
 *
 * PRIVACY CONTRACT (never relaxed): the summary carries kinds, roles,
 * media types, counts, and bounded structural measurements ONLY. It MUST NOT
 * carry prompt text, base64/inline data, raw tool arguments or results,
 * secrets, model identifiers of the user's choosing beyond the configured
 * model id, or any full request body. Every field below is a classifier or a
 * count, chosen so the summary cannot reconstruct content.
 */

import type { ContentBlock, LLMMessage } from "../types";

/** Upper bound on distinct tool names surfaced, matching fetch-logger. */
const MAX_TOOL_NAMES = 10;

/** Per-message structural summary. No content, only kinds/counts/ids-shape. */
export interface MessageShapeSummary {
	/** The Bound message role (user/assistant/tool_result/developer/…). */
	role: string;
	/** `true` when `content` was a bare string rather than a block array. */
	stringContent: boolean;
	/** Count of each content-block `type` present (text/image/tool_use/…). */
	blockKinds: Record<string, number>;
	/**
	 * For a tool_result message, the output forms its blocks reduce to —
	 * `text` (all-text, flattened to a string output) or `content` (carries
	 * at least one non-text block, emitted as a structured content array).
	 * Absent for non-tool_result messages.
	 */
	toolResultOutputForm?: "text" | "content";
	/** Media types of image/document blocks (IANA type only, never data). */
	mediaTypes?: string[];
	/** `true` when this message carries a `tool_use_id` (shape, not value). */
	hasToolUseId?: boolean;
}

/** Whole-request structural summary fed to the diagnostic log line. */
export interface RequestShapeSummary {
	messageCount: number;
	/** Count of messages per role. */
	roleCounts: Record<string, number>;
	/** Count of content blocks per `type`, summed across all messages. */
	blockKindCounts: Record<string, number>;
	/** Distinct media types across all image/document blocks (bounded). */
	mediaTypes: string[];
	/** Distinct tool names referenced by tool_use blocks (bounded). */
	toolNames: string[];
	/** Count of tool_result messages by their reduced output form. */
	toolResultOutputForms: Record<string, number>;
	/** Per-message shape, in order. */
	messages: MessageShapeSummary[];
}

function blocksOf(message: LLMMessage): ContentBlock[] | null {
	return Array.isArray(message.content) ? message.content : null;
}

/**
 * Reduce one message to its privacy-safe structural shape. Mirrors the
 * tool_result output-form decision in `buildToolResultOutput` (all-text →
 * `text`, any non-text → `content`) so the summary names the exact wire form
 * the bridge would have emitted, without reproducing any payload.
 */
function summarizeMessageShape(message: LLMMessage): MessageShapeSummary {
	const summary: MessageShapeSummary = {
		role: message.role,
		stringContent: typeof message.content === "string",
		blockKinds: {},
	};
	if (message.tool_use_id !== undefined) summary.hasToolUseId = true;

	const blocks = blocksOf(message);
	if (blocks === null) return summary;

	const mediaTypes = new Set<string>();
	let hasNonText = false;
	for (const block of blocks) {
		summary.blockKinds[block.type] = (summary.blockKinds[block.type] ?? 0) + 1;
		if (block.type !== "text") hasNonText = true;
		if (block.type === "image" || block.type === "document") {
			// media_type is an IANA label (e.g. "image/png"), never the data.
			const mt = block.source.media_type;
			if (typeof mt === "string") mediaTypes.add(mt);
		}
	}
	if (mediaTypes.size > 0) summary.mediaTypes = [...mediaTypes];
	if (message.role === "tool_result") {
		summary.toolResultOutputForm = hasNonText ? "content" : "text";
	}
	return summary;
}

/**
 * Build a privacy-safe structural summary of the messages that produced a
 * Responses request. Carries only kinds, roles, media types, counts, and
 * stable-identifier presence — never text, data, arguments, or results.
 */
export function summarizeRequestShape(messages: LLMMessage[]): RequestShapeSummary {
	const roleCounts: Record<string, number> = {};
	const blockKindCounts: Record<string, number> = {};
	const toolResultOutputForms: Record<string, number> = {};
	const mediaTypes = new Set<string>();
	const toolNames = new Set<string>();
	const perMessage: MessageShapeSummary[] = [];

	for (const message of messages) {
		roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
		const shape = summarizeMessageShape(message);
		perMessage.push(shape);

		for (const [kind, n] of Object.entries(shape.blockKinds)) {
			blockKindCounts[kind] = (blockKindCounts[kind] ?? 0) + n;
		}
		if (shape.toolResultOutputForm) {
			toolResultOutputForms[shape.toolResultOutputForm] =
				(toolResultOutputForms[shape.toolResultOutputForm] ?? 0) + 1;
		}
		for (const mt of shape.mediaTypes ?? []) mediaTypes.add(mt);

		const blocks = blocksOf(message);
		if (blocks) {
			for (const block of blocks) {
				if (block.type === "tool_use") toolNames.add(block.name);
			}
		}
	}

	return {
		messageCount: messages.length,
		roleCounts,
		blockKindCounts,
		mediaTypes: [...mediaTypes],
		toolNames: [...toolNames].slice(0, MAX_TOOL_NAMES),
		toolResultOutputForms,
		messages: perMessage,
	};
}

/**
 * Classify whether an error is the OpenAI Responses request-body rejection we
 * want shape diagnostics for — `Invalid 'input': value did not match any
 * expected variant` and the broader family of `invalid request body` /
 * invalid-`input` 400s from the Responses endpoint. Duck-types on the error's
 * message and response body rather than importing the SDK's error classes
 * (same stance as `mapError`). A false positive only costs one extra debug
 * log line; a false negative loses the one artifact we cannot recover later,
 * so the matcher errs toward catching the family.
 */
export function isResponsesInputRejection(err: unknown): boolean {
	const haystacks: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === "string" && v.length > 0) haystacks.push(v.toLowerCase());
	};
	// Walk the common AI SDK error shape: the RetryError wraps lastError, and
	// APICallError stashes the provider explanation on responseBody while
	// `.message` is the bare status text.
	const seen = new Set<unknown>();
	let node: unknown = err;
	for (let depth = 0; depth < 4 && node && !seen.has(node); depth++) {
		seen.add(node);
		const e = node as {
			message?: unknown;
			responseBody?: unknown;
			lastError?: unknown;
			cause?: unknown;
		};
		push(e.message);
		push(e.responseBody);
		node = e.lastError ?? e.cause;
	}
	if (haystacks.length === 0) return false;
	const text = haystacks.join(" ");
	// The canonical message, plus the two broader request-body-rejection
	// phrasings the Responses endpoint uses for a malformed `input`.
	if (text.includes("did not match any expected variant")) return true;
	if (text.includes("invalid request body") && text.includes("input")) return true;
	if (text.includes("invalid 'input'") || text.includes('invalid "input"')) return true;
	return false;
}
