import type { LLMMessage, ToolDefinition } from "@bound/llm";
import type { ContextSection } from "@bound/shared";

export interface CachedTurnState {
	/** The stored messages array from the previous turn */
	messages: LLMMessage[];
	/** The system prompt string (stable content only) */
	systemPrompt: string;
	/** Indices of cache messages in the stored array */
	cacheMessagePositions: number[];
	/** Index of the fixed cache message (set on cold path, never moves while warm) */
	fixedCacheIdx: number;
	/** created_at of the last message in the stored array (for DB delta query) */
	lastMessageCreatedAt: string;
	/** Hash of tool definitions — change triggers cold path */
	toolFingerprint: string;
	/**
	 * Section breakdown captured from the cold-path build. Reused on warm hits
	 * so context_debug.sections stays populated across the warm-path lifecycle.
	 * Stable-prefix sections (system, skill-context, tools) are reused as-is;
	 * dynamic ones (history, memory, task-digest, volatile-other) are recomputed
	 * from the current turn's volatile context and stored messages.
	 */
	debugSections?: ContextSection[];
}

/**
 * Compute a deterministic fingerprint for the current tool set.
 * Uses sorted tool names and parameters to ensure stability across calls.
 * Returns a 16-character hex string (SHA256 truncated).
 */
export function computeToolFingerprint(tools: ToolDefinition[] | undefined): string {
	if (!tools || tools.length === 0) return "empty";

	// Sort by tool name for determinism, then stringify
	const sorted = [...tools].sort((a, b) => a.function.name.localeCompare(b.function.name));

	const key = sorted
		.map((t) => `${t.function.name}:${JSON.stringify(t.function.parameters)}`)
		.join("|");

	// Use Bun's CryptoHasher for SHA256
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(key);
	return hasher.digest("hex").slice(0, 16);
}
