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
import type { ModelResolution } from "./model-resolution";

/**
 * Parse tool result content for the in-memory LLM message path.
 * When content is a JSON-serialized ContentBlock[] containing image blocks,
 * returns the parsed array so drivers can include images in the API call.
 * Otherwise returns the original string unchanged.
 */
export function parseToolResultContent(content: string): string | ContentBlock[] {
	try {
		const parsed = JSON.parse(content);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed[0]?.type &&
			parsed.some((b: Record<string, unknown>) => b.type === "image")
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
	}

	// Pattern-match on known transient transport error messages
	return (
		errMsg.includes("http2") || errMsg.includes("ECONNRESET") || errMsg.includes("socket hang up")
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
	role: string;
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
	const row: Record<string, unknown> = {
		id,
		thread_id: opts.threadId,
		role: opts.role,
		content: opts.content,
		model_id: opts.modelId ?? null,
		tool_name: opts.toolName ?? null,
		created_at: now,
		modified_at: now,
		host_origin: opts.hostOrigin,
	};
	if (opts.exitCode !== undefined) {
		row.exit_code = opts.exitCode;
	}
	insertRow(db, "messages", row, siteId);
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
		if (chunk.type === "text") {
			textContent += chunk.content;
		} else if (chunk.type === "thinking") {
			thinkingContent += chunk.content;
			if (chunk.signature) thinkingSignature = chunk.signature;
		} else if (chunk.type === "tool_use_start") {
			argsAccumulator.set(chunk.id, "");
			nameMap.set(chunk.id, chunk.name);
		} else if (chunk.type === "tool_use_args") {
			const existing = argsAccumulator.get(chunk.id) ?? "";
			argsAccumulator.set(chunk.id, existing + chunk.partial_json);
		} else if (chunk.type === "tool_use_end") {
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
				console.warn(
					`[parseStreamChunks] Failed to parse tool_use args for "${name}" (id=${chunk.id}), ` +
						`args length=${fullArgsJson.length}. Output likely truncated by max_tokens limit. ` +
						`Raw args prefix: ${fullArgsJson.slice(0, 200)}`,
				);
			}
			toolCalls.push({
				id: chunk.id,
				name,
				input,
				argsJson: fullArgsJson,
				truncated,
			});
		} else if (chunk.type === "done") {
			inputTokens = chunk.usage.input_tokens;
			outputTokens = chunk.usage.output_tokens;
			cacheWriteTokens = chunk.usage.cache_write_tokens;
			cacheReadTokens = chunk.usage.cache_read_tokens;
			usageEstimated = chunk.usage.estimated;
		}
	}

	return {
		textContent,
		thinking: thinkingContent || null,
		thinkingSignature,
		toolCalls,
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
		content,
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
