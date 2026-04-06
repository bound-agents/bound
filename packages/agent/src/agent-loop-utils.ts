import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import { type CapabilityRequirements, LLMError } from "@bound/llm";
import type { ModelResolution } from "./model-resolution";

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
