import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import {
	type CapabilityRequirements,
	type ContentBlock,
	LLMError,
	type LLMMessage,
	type StreamChunk,
} from "@bound/llm";
import { createLogger } from "@bound/shared";
import type { ModelResolution } from "./model-resolution";
import type { RelayWaitResult } from "./relay-wait$";
import type { RegisteredTool } from "./types";

const logger = createLogger("@bound/agent", "agent-loop-utils");

/**
 * Parse persisted message content for the in-memory LLM message path.
 * When content is a JSON-serialized ContentBlock[] carrying a non-text block
 * (image or document), returns the parsed array so drivers can deliver the
 * structured content in the API call. Otherwise returns the original string
 * unchanged.
 *
 * This is the readback counterpart to the live tool-result branch in
 * agent-loop.ts: any role whose row holds a serialized ContentBlock[] — a
 * user prompt with an attached image, or a tool_result with a binary blob —
 * must be parsed back to blocks here, or the driver receives the literal JSON
 * text and the image/document never reaches the model. The image/document
 * guard avoids false-positives on plain-text content that happens to be valid
 * JSON: text-only content is delivered identically as a string.
 */
export function parseContentBlocks(content: string): string | ContentBlock[] {
	try {
		const parsed = JSON.parse(content);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed[0]?.type &&
			parsed.some((b: Record<string, unknown>) => b.type === "image" || b.type === "document")
		) {
			return parsed as ContentBlock[];
		}
	} catch {
		// Not JSON — return as-is
	}
	return content;
}

/**
 * Determines whether an LLM error is a transient transport issue worth retrying.
 * Returns false for client errors (4xx except 429) — these indicate a malformed
 * request that will fail identically on retry.
 */
export function isTransientLLMError(error: unknown): boolean {
	const errMsg = error instanceof Error ? error.message : String(error);

	// If we have a status code, use it as the primary signal.
	// 4xx errors (except 429 rate-limit) are client errors — not transient.
	if (error instanceof LLMError && error.statusCode !== undefined) {
		if (error.statusCode === 429) return false; // handled separately by rate-limit logic
		if (error.statusCode >= 400 && error.statusCode < 500) return false;
		// 5xx is a server fault, not a client error — the textbook transient case.
		// bedrock-mantle intermittently 500s mid-stream (server_error); the bridge
		// throws it as a 5xx LLMError (commit eda6ce6b). Retry (with backoff at the
		// call site) clears the intermittent blip — verified via probe (4/6 cold
		// attempts succeeded). withEmptyRetry already proved instant no-backoff
		// retry of this same fault does NOT clear it, so the retry path must wait.
		if (error.statusCode >= 500) return true;
	}

	// Pattern-match on known transient transport error messages.
	// "timed out" (two words) catches the runtime fetch transport's own
	// ~300s ceiling, which fires below the AI SDK and wraps as a TimeoutError
	// ("The operation timed out") with no HTTP status — a connection that
	// times out with no response is transient. Deliberately NOT "timeout"
	// (one word): message-handler's 35-min inactivity abort uses "LLM
	// response timeout" and must surface as a genuine stall, not retry.
	return (
		errMsg.includes("http2") ||
		errMsg.includes("ECONNRESET") ||
		errMsg.includes("socket hang up") ||
		// undici's message when the TCP socket drops mid-request without a
		// response — fires on z.ai and other streaming endpoints that hold
		// connections open for long completions. Distinct from "socket hang
		// up" (node http) and ECONNRESET (raw TCP reset).
		errMsg.includes("socket connection was closed") ||
		errMsg.includes("timed out") ||
		errMsg.includes("ETIMEDOUT")
	);
}

/**
 * Finds the first user message in a thread that arrived after the last
 * assistant response — i.e., a message that was likely skipped because
 * the agent loop was already active when it was delivered.
 *
 * Used by the start.ts event handler in its `finally` block: after a loop
 * completes, call this to detect queue-skipped messages and re-trigger.
 */
export function findPendingUserMessage(
	db: Database,
	threadId: string,
): { id: string; content: string; role: "user" } | null {
	const lastAssistant = db
		.prepare<{ created_at: string }, [string]>(
			"SELECT created_at FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId);

	const cutoff = lastAssistant?.created_at ?? "1970-01-01T00:00:00.000Z";

	return (
		(db
			.prepare<{ id: string; content: string; role: "user" }, [string, string]>(
				"SELECT id, content, role FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 AND created_at > ? ORDER BY created_at ASC LIMIT 1",
			)
			.get(threadId, cutoff) as { id: string; content: string; role: "user" } | null) ?? null
	);
}

// ---------------------------------------------------------------------------
// Message insertion
// ---------------------------------------------------------------------------

interface ThreadMessageOpts {
	threadId: string;
	role: import("@bound/shared").MessageRole;
	content: string;
	hostOrigin: string;
	modelId?: string | null;
	toolName?: string | null;
	exitCode?: number;
}

/** Insert a message into a thread via the change-log outbox. Returns the message ID. */
export function insertThreadMessage(db: Database, opts: ThreadMessageOpts, siteId: string): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		db,
		"messages",
		{
			id,
			thread_id: opts.threadId,
			role: opts.role,
			content: opts.content,
			model_id: opts.modelId ?? null,
			tool_name: opts.toolName ?? null,
			created_at: now,
			modified_at: now,
			host_origin: opts.hostOrigin,
			deleted: 0,
			exit_code: opts.exitCode ?? null,
			metadata: null,
		},
		siteId,
	);
	return id;
}

// ---------------------------------------------------------------------------
// Command output formatting
// ---------------------------------------------------------------------------

/** Build a human-readable result string from command stdout/stderr/exitCode. */
export function buildCommandOutput(
	stdout: string | undefined,
	stderr: string | undefined,
	exitCode: number | undefined,
): string {
	const parts: string[] = [];
	if (stdout) parts.push(stdout);
	if (stderr) parts.push(stderr);
	if (parts.length === 0) {
		parts.push(
			(exitCode ?? 0) === 0 ? "Command completed successfully" : `Exit code: ${exitCode ?? 1}`,
		);
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

interface UsageTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
}

interface BackendPricing {
	id: string;
	price_per_m_input?: number;
	price_per_m_output?: number;
	price_per_m_cache_read?: number;
	price_per_m_cache_write?: number;
}

/** Compute cost in USD for a turn's token usage against backend pricing. */
export function calculateTurnCost(
	modelId: string,
	usage: UsageTokens,
	backends: BackendPricing[],
): number {
	const cfg = backends.find((b) => b.id === modelId);
	if (!cfg) return 0;

	const inputCost = (usage.inputTokens * (cfg.price_per_m_input ?? 0)) / 1_000_000;
	const outputCost = (usage.outputTokens * (cfg.price_per_m_output ?? 0)) / 1_000_000;
	const cacheReadCost =
		((usage.cacheReadTokens ?? 0) * (cfg.price_per_m_cache_read ?? 0)) / 1_000_000;
	const cacheWriteCost =
		((usage.cacheWriteTokens ?? 0) * (cfg.price_per_m_cache_write ?? 0)) / 1_000_000;

	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Compute the worst-case turn cost ceiling for a backend in USD: full
 * context-window of input + max-output. Useful for budget forecasting
 * (e.g. by the agent-harness diagnostic) without running a turn.
 *
 * Defaults match `BackendConfig` schema defaults: 200k context window,
 * 8k max-output, zero pricing if unset. The result is a strict upper
 * bound — actual turn cost is almost always lower.
 */
export function estimateMaxTurnCost(backend: {
	context_window?: number;
	max_output_tokens?: number;
	price_per_m_input?: number;
	price_per_m_output?: number;
}): number {
	const ctxWindow = backend.context_window ?? 200_000;
	const maxOutput = backend.max_output_tokens ?? 8_000;
	const inputPrice = backend.price_per_m_input ?? 0;
	const outputPrice = backend.price_per_m_output ?? 0;
	return (ctxWindow * inputPrice + maxOutput * outputPrice) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Model resolution helpers
// ---------------------------------------------------------------------------

/** Extract a display-safe model ID from a ModelResolution, with fallback. */
export function getResolvedModelId(resolution: ModelResolution | null, fallback?: string): string {
	if (resolution && resolution.kind !== "error") {
		return resolution.modelId;
	}
	return fallback ?? "unknown";
}

/**
 * Reconciles the agent-loop default `max_tokens` budget with a per-backend
 * cap configured in `model_backends.json#max_output_tokens`. Returns
 * `min(defaultMax, cap)` when `cap` is a positive integer, otherwise
 * returns `defaultMax` unchanged.
 *
 * Exists because some Bedrock models reject the default
 * `DEFAULT_MAX_OUTPUT_TOKENS` (16_384) with
 * `max_tokens exceeds model limit of N` — notably Nova Pro (N=10_000).
 * The backend cap is treated as an upper bound only: if an operator
 * misconfigures a cap above the default, the default still wins so the
 * per-turn budget can never be raised behind the loop's back.
 *
 * Exported so both the agent-loop (local path) and the relay-processor
 * (receiver side) can reuse a single definition — defence-in-depth against
 * stale requester payloads that still carry the old default.
 */
export function clampMaxOutputTokens(defaultMax: number, cap: number | undefined): number {
	if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return defaultMax;
	return Math.min(defaultMax, Math.floor(cap));
}

// ---------------------------------------------------------------------------
// Capability requirement detection
// ---------------------------------------------------------------------------

/** Detect capability requirements for a thread (vision, tool_use). */
export function deriveCapabilityRequirements(
	db: Database,
	threadId: string,
	hasTools: boolean,
): CapabilityRequirements | undefined {
	const req: CapabilityRequirements = {};

	if (hasTools) {
		req.tool_use = true;
	}

	try {
		const recentMsgs = db
			.query(
				`SELECT content FROM messages
				 WHERE thread_id = ? AND deleted = 0
				 ORDER BY created_at DESC LIMIT 5`,
			)
			.all(threadId) as Array<{ content: string }>;

		const hasImageBlock = recentMsgs.some((m) => {
			try {
				const blocks = JSON.parse(m.content);
				return Array.isArray(blocks) && blocks.some((b: { type?: string }) => b.type === "image");
			} catch {
				return false;
			}
		});

		if (hasImageBlock) {
			req.vision = true;
		}
	} catch {
		// Non-fatal: proceed without vision requirement
	}

	return Object.keys(req).length > 0 ? req : undefined;
}

// ---------------------------------------------------------------------------
// Stream chunk parsing
// ---------------------------------------------------------------------------

export interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	argsJson: string;
	/** True when the tool_use args JSON failed to parse (likely output truncation). */
	truncated?: boolean;
}

/**
 * Drop superseded tool-call drafts that some Responses-API providers surface as
 * independent tool calls while the model is still converging on the final call.
 *
 * GPT-5.5 on Mantle has emitted `call_2`, `call_4`, …, `call_108` for one
 * intended `boundless_write`: dozens of earlier same-tool entries had `{}` or a
 * truncated prefix while the final later entry carried the real arguments. The
 * agent loop executes only after the full stream is parsed, so at this boundary
 * we can safely keep the final complete call and discard earlier drafts without
 * disabling genuinely parallel tool calling across different tools.
 */
export function dropSupersededToolCallDrafts<T extends ParsedToolCall>(calls: T[]): T[] {
	if (calls.length < 2) return calls;
	const emptyCountsByTool = new Map<string, number>();
	for (const call of calls) {
		if (isEmptyObjectCall(call)) {
			emptyCountsByTool.set(call.name, (emptyCountsByTool.get(call.name) ?? 0) + 1);
		}
	}

	const keep = calls.map(() => true);
	for (let i = 0; i < calls.length; i++) {
		for (let j = i + 1; j < calls.length; j++) {
			if (
				isSupersededToolCallDraft(calls[i], calls[j], emptyCountsByTool.get(calls[i].name) ?? 0)
			) {
				keep[i] = false;
				break;
			}
		}
	}
	return calls.filter((_, i) => keep[i]);
}

function isSupersededToolCallDraft(
	earlier: ParsedToolCall,
	later: ParsedToolCall,
	emptySameToolCount: number,
): boolean {
	if (earlier.name !== later.name) return false;
	if (later.truncated) return false;

	const earlierArgs = earlier.argsJson.trim();
	const laterArgs = later.argsJson.trim();
	if (earlier.truncated && (earlierArgs === "" || laterArgs.startsWith(earlierArgs))) {
		return true;
	}

	// A single zero-argument tool call can be legitimate; the production anomaly
	// was a same-tool ladder of many `{}` drafts followed by the real payload.
	// Require at least two empty same-tool calls before treating them as drafts.
	return emptySameToolCount > 1 && isEmptyObjectCall(earlier) && !isEmptyObjectCall(later);
}

function isEmptyObjectCall(call: ParsedToolCall): boolean {
	return !call.truncated && call.argsJson.trim() === "{}" && Object.keys(call.input).length === 0;
}

export interface ParsedResponse {
	textContent: string;
	thinking: string | null;
	thinkingSignature: string | null;
	toolCalls: ParsedToolCall[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheWriteTokens: number | null;
		cacheReadTokens: number | null;
		usageEstimated: boolean;
	};
}

/**
 * Parses a stream of LLM response chunks into a structured response.
 * Thinking chunks are collected separately and never mixed into textContent.
 */
export function parseStreamChunks(chunks: StreamChunk[]): ParsedResponse {
	let textContent = "";
	let thinkingContent = "";
	let thinkingSignature: string | null = null;
	const toolCalls: ParsedToolCall[] = [];
	const argsAccumulator = new Map<string, string>();
	const nameMap = new Map<string, string>();
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheWriteTokens: number | null = null;
	let cacheReadTokens: number | null = null;
	let usageEstimated = false;

	for (const chunk of chunks) {
		switch (chunk.type) {
			case "text":
				textContent += chunk.content;
				break;
			case "thinking":
				thinkingContent += chunk.content;
				if (chunk.signature) thinkingSignature = chunk.signature;
				break;
			case "tool_use_start":
				argsAccumulator.set(chunk.id, "");
				nameMap.set(chunk.id, chunk.name);
				break;
			case "tool_use_args": {
				const existing = argsAccumulator.get(chunk.id) ?? "";
				argsAccumulator.set(chunk.id, existing + chunk.partial_json);
				break;
			}
			case "tool_use_end": {
				// Empty accumulator = zero-argument tool call (no tool_use_args chunks streamed).
				// `??` only catches undefined, so empty-string would fall through to JSON.parse("")
				// and spuriously flag the call as truncated. Treat "" and undefined alike as "{}".
				const rawArgs = argsAccumulator.get(chunk.id);
				const fullArgsJson = rawArgs && rawArgs.length > 0 ? rawArgs : "{}";
				const name = nameMap.get(chunk.id) ?? chunk.id;
				let input: Record<string, unknown> = {};
				let truncated = false;
				try {
					input = JSON.parse(fullArgsJson);
				} catch {
					truncated = true;
					logger.warn("Failed to parse tool_use args; output likely truncated by max_tokens", {
						toolName: name,
						id: chunk.id,
						argsLength: fullArgsJson.length,
						rawArgsPrefix: fullArgsJson.slice(0, 200),
					});
				}
				toolCalls.push({
					id: chunk.id,
					name,
					input,
					argsJson: fullArgsJson,
					truncated,
				});
				break;
			}
			case "done":
				inputTokens = chunk.usage.input_tokens;
				outputTokens = chunk.usage.output_tokens;
				cacheWriteTokens = chunk.usage.cache_write_tokens;
				cacheReadTokens = chunk.usage.cache_read_tokens;
				usageEstimated = chunk.usage.estimated;
				break;
			case "error":
				logger.warn("Stream error chunk received during aggregation", { error: chunk.error });
				break;
			case "heartbeat":
				break;
			default: {
				const _exhaustive: never = chunk;
				void _exhaustive;
			}
		}
	}

	return {
		textContent,
		thinking: thinkingContent || null,
		thinkingSignature,
		toolCalls: dropSupersededToolCallDrafts(toolCalls),
		usage: {
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			usageEstimated,
		},
	};
}

/**
 * Wait for a relay inbox entry with a given ref_id, using event-driven listening + DB polling.
 * Tests can use this helper to verify the timeout/event-wait pattern used in _relayWaitImpl.
 *
 * @param db Database instance
 * @param eventBus Event emitter for relay:inbox events
 * @param refId ref_id to match
 * @param timeoutMs Max time to wait before returning null
 * @returns RelayInboxEntry if found, null if timeout
 */
export async function waitForRelayInbox(
	db: Database,
	eventBus: {
		on: (
			event: string,
			handler: (e: { ref_id?: string; stream_id?: string; kind: string }) => void,
		) => void;
		off?: (
			event: string,
			handler: (e: { ref_id?: string; stream_id?: string; kind: string }) => void,
		) => void;
	},
	refId: string,
	timeoutMs = 30000,
): Promise<{ id: string; kind: string } | null> {
	const { readInboxByRefId } = await import("@bound/core");

	return new Promise((resolve) => {
		const timeoutId = setTimeout(() => {
			cleanup();
			resolve(null);
		}, timeoutMs);

		const onInbox = (event: { ref_id?: string; stream_id?: string; kind: string }) => {
			if (event.ref_id !== refId) return;

			// Check DB for the actual entry
			const entry = readInboxByRefId(db, refId);
			if (entry) {
				cleanup();
				resolve({ id: entry.id, kind: entry.kind });
			}
		};

		eventBus.on("relay:inbox", onInbox);

		// Also check DB immediately (race condition: entry may have arrived before listener attached)
		const immediate = readInboxByRefId(db, refId);
		if (immediate) {
			cleanup();
			resolve({ id: immediate.id, kind: immediate.kind });
			return;
		}

		function cleanup() {
			clearTimeout(timeoutId);
			if (eventBus.off) {
				eventBus.off("relay:inbox", onInbox);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Warm-path delta message conversion
// ---------------------------------------------------------------------------

interface DbMessageRow {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
	modified_at: string | null;
	host_origin: string;
	deleted: number;
}

/**
 * Convert a DB message row to an LLMMessage with minimal sanitization.
 *
 * Handles tool pair validation: a `tool_result` is valid when it follows
 * either a `tool_call` (single or first of a parallel batch) OR another
 * `tool_result` that is itself part of the ongoing parallel-tool-call
 * response. Only a `tool_result` with no `tool_call` anywhere upstream in
 * the conversion is considered orphaned and dropped.
 *
 * The caller (`convertDeltaMessages`) tracks whether a `tool_call` has
 * been seen via the `toolCallSeen` flag so the predicate is accurate even
 * when the delta contains many consecutive `tool_result` rows.
 */
export function convertDbRowToLLMMessage(
	row: DbMessageRow,
	previousRole?: string,
	toolCallSeen?: boolean,
): LLMMessage | null {
	const { role, content, tool_name, model_id, host_origin } = row;

	// Validate tool pairs. `tool_result` must follow `tool_call` directly OR
	// be part of a run of `tool_result` messages responding to that call
	// (parallel tool calls emit N consecutive `tool_result` DB rows).
	if (role === "tool_result") {
		const followsToolCall = previousRole === "tool_call";
		const followsToolResultAfterCall = previousRole === "tool_result" && toolCallSeen === true;
		if (!followsToolCall && !followsToolResultAfterCall) {
			return null; // Drop orphaned tool_result
		}
	}

	const msg: LLMMessage = {
		role: role as LLMMessage["role"],
		// Readback seam: any role whose row holds a serialized ContentBlock[]
		// (a user prompt with an attached image, a tool_result with a binary
		// blob) is parsed back to blocks here. Without this, the driver
		// receives the literal JSON text and the image/document never reaches
		// the model. The live tool-result branch in agent-loop.ts handles the
		// just-executed case; this covers every DB-readback path.
		content: parseContentBlocks(content),
	};

	if (tool_name) {
		msg.tool_use_id = tool_name;
	}
	if (model_id) {
		msg.model_id = model_id;
	}
	if (host_origin) {
		msg.host_origin = host_origin;
	}

	return msg;
}

/**
 * Convert delta DB rows to LLMMessages, filtering orphaned tool_results.
 * Returns array of valid messages with tool pairs intact.
 *
 * Tracks `toolCallSeen` so consecutive `tool_result` rows following a
 * parallel `tool_call` are preserved rather than dropped after the first.
 * The flag resets whenever a non-tool message breaks the run.
 */
export function convertDeltaMessages(rows: DbMessageRow[]): LLMMessage[] {
	const messages: LLMMessage[] = [];
	let lastRole: string | undefined;
	let toolCallSeen = false;

	for (const row of rows) {
		const msg = convertDbRowToLLMMessage(row, lastRole, toolCallSeen);
		if (msg) {
			messages.push(msg);
			lastRole = msg.role;
			if (msg.role === "tool_call") {
				toolCallSeen = true;
			} else if (msg.role !== "tool_result") {
				// Any non-tool message ends the parallel-tool-call run.
				toolCallSeen = false;
			}
		}
	}

	return messages;
}

/**
 * Scan an LLMMessage[] for tool_calls whose tool_use ids are not matched by a
 * following tool_result before any non-tool message appears.
 *
 * The warm path appends delta messages to a previously-assembled prefix
 * WITHOUT re-running the full tool-pair sanitizer in `context-assembly.ts`.
 * When a tool_call was left pending at turn boundary (e.g. a long-running
 * client tool that hadn't returned before the user sent a follow-up, or the
 * agent loop yielded mid-batch), the merged warm-path array can contain a
 * tool_call with no tool_result. Sending that to the AI SDK raises
 * `MissingToolResultsError` and the whole turn errors out. Detect the
 * condition so the caller can fall through to the cold path, where Stage 3
 * sanitization synthesizes the missing results.
 *
 * Matches the semantics used by the AI SDK's prompt validator: a tool_call's
 * tool_use ids are considered answered only when every id is followed by a
 * tool_result (in any order) BEFORE the next user / assistant / system turn.
 * Tool-call content that fails to parse as JSON ContentBlock[] is treated as
 * a single opaque tool_use — absent any matching tool_result it is still an
 * orphan.
 */
export function hasOrphanedToolCall(messages: LLMMessage[]): boolean {
	const pending = new Set<string>();
	let inActiveToolCall = false;

	const closeWindow = (): boolean => {
		if (pending.size > 0 || inActiveToolCall) return true;
		return false;
	};

	for (const msg of messages) {
		if (msg.role === "tool_call") {
			// A new tool_call opens a fresh pending window. If the previous
			// tool_call still has unmatched ids, that's already an orphan —
			// report it up.
			if (closeWindow()) return true;
			pending.clear();
			inActiveToolCall = true;
			const content = Array.isArray(msg.content) ? msg.content : msg.content;
			try {
				const blocks =
					typeof content === "string" ? JSON.parse(content) : (content as ContentBlock[]);
				if (Array.isArray(blocks)) {
					for (const b of blocks) {
						if ((b as { type?: string }).type === "tool_use" && (b as { id?: string }).id) {
							pending.add((b as { id: string }).id);
						}
					}
				}
			} catch {
				// Non-parseable content: treat as one opaque tool_use. The
				// inActiveToolCall flag alone is enough to flag it as an
				// orphan if no tool_result follows.
			}
			continue;
		}

		if (msg.role === "tool_result") {
			if (!inActiveToolCall) {
				// Orphan tool_result on its own — no tool_call in scope.
				return true;
			}
			if (msg.tool_use_id) {
				pending.delete(msg.tool_use_id);
			}
			// Any result satisfies the opaque single-tool case.
			if (pending.size === 0) {
				inActiveToolCall = false;
			}
			continue;
		}

		if (msg.role === "cache" || msg.role === "developer") {
			// Cache markers and developer tails are protocol-internal and
			// can legitimately appear anywhere — they do NOT close a tool
			// pair window.
			continue;
		}

		// Any real conversation role (user / assistant / system) closes the
		// tool pair window. Unmatched ids at this point are orphans.
		if (closeWindow()) return true;
		pending.clear();
		inActiveToolCall = false;
	}

	// End of messages — surviving pending ids are orphans.
	return closeWindow();
}

/**
 * Decide whether a relay tool call should be re-dispatched after a failure.
 *
 * Retry policy:
 *   - Aborted runs never retry.
 *   - The retry budget (`attempt < maxAttempts`) is hard-capped.
 *   - `retriable=false` is final; never retry.
 *   - `definitely_not_executed=true` (hub fast-fail) — always retry. Strongest
 *     signal; the target tool provably never ran, so retry is safe even for
 *     non-idempotent tools.
 *   - `annotations.readOnly === true` or `annotations.idempotent === true` —
 *     retry safe. A duplicate execution leaves the system in the same final
 *     state as a single execution. Used for ambiguous failures (full timeouts,
 *     target-side errors) where the target may have started executing.
 *   - Otherwise — refuse. The agent surfaces the error to the model rather
 *     than risking a silent double-execution.
 *
 * Annotation trust model: per the MCP spec, `idempotentHint`/`readOnlyHint`
 * are HINTS, not guarantees. A target's tool can lie about being idempotent.
 * Worst case: their bug → double execution. We use these for retry policy
 * only, never for security gating.
 */
export interface ToolAnnotations {
	idempotent?: boolean;
	readOnly?: boolean;
}

export interface ShouldRetryRelayCallInput {
	waitResult: RelayWaitResult;
	attempt: number;
	maxAttempts: number;
	aborted: boolean;
	annotations?: ToolAnnotations;
}

export function shouldRetryRelayCall(input: ShouldRetryRelayCallInput): boolean {
	if (input.aborted) return false;
	if (input.attempt >= input.maxAttempts) return false;
	if (!input.waitResult.retriable) return false;
	if (input.waitResult.definitely_not_executed === true) return true;
	if (input.annotations?.readOnly === true) return true;
	if (input.annotations?.idempotent === true) return true;
	// Ambiguous-execution case: target may have started executing and we don't
	// have idempotency information. Refuse to retry rather than risk a double
	// side effect. The model sees the error and can decide what to do.
	return false;
}

/**
 * Look up a tool's idempotency annotations from the local registry. Prefers
 * `resolveAnnotations(args)` (per-action) when defined; falls back to the
 * static `idempotent`/`readOnly` fields. Returns an empty object for unknown
 * tools — the agent loop treats that as "no annotation info".
 *
 * Currently scoped to the local tool registry. Relay-routed tools (where the
 * target's annotations live on a different host) are resolved separately at
 * dispatch time and the result is carried on the relay request itself.
 */
export function resolveToolAnnotations(
	registry: Map<string, RegisteredTool>,
	toolName: string,
	args: Record<string, unknown>,
): ToolAnnotations {
	const tool = registry.get(toolName);
	if (!tool) return {};
	if (tool.resolveAnnotations) {
		return tool.resolveAnnotations(args);
	}
	const result: ToolAnnotations = {};
	if (tool.idempotent !== undefined) result.idempotent = tool.idempotent;
	if (tool.readOnly !== undefined) result.readOnly = tool.readOnly;
	return result;
}

/**
 * Build a `resolveFileRef` callback for ChatParams that fetches base64 file
 * bytes from the local `files` table. Used as defense-in-depth so file_ref
 * images and documents survive even when context-assembly's pre-resolution
 * was bypassed (test paths, future code paths). When the file row is missing
 * or has empty content, returns null and the LLM bridge emits a clear
 * `[Image unavailable: …]` placeholder rather than silently dropping.
 */
export function createFileRefResolver(db: Database): (fileId: string) => string | null {
	return (fileId: string) => {
		const row = db.query("SELECT content FROM files WHERE id = ? AND deleted = 0").get(fileId) as {
			content: string | null;
		} | null;
		return row?.content ?? null;
	};
}
