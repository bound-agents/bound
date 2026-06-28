import type { LLMMessage, ToolDefinition } from "@bound/llm";
import type { ContextSection } from "@bound/shared";
import { compareBytewise } from "@bound/shared";

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
 * Canonicalize a value for hashing so the result is independent of object-key
 * insertion order. `JSON.stringify` preserves key order, so a `parameters`
 * schema re-parsed or rebuilt with its keys in a different order between turns
 * would otherwise serialize differently and flip the tool fingerprint. Arrays
 * keep their order (semantically meaningful); object keys are sorted bytewise
 * (locale-independent, matching the tool-name sort) and recursed.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort(compareBytewise)) {
			out[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/**
 * Compute a deterministic fingerprint for the current tool set.
 * Independent of tool array order (sorted by name) and of parameter-schema key
 * order (canonicalized), so the same logical tool set always hashes the same —
 * a different fingerprint means the tool set genuinely changed. Returns a
 * 16-character hex string (SHA256 truncated).
 *
 * Pass the tool list the model actually receives (the merged registry +
 * client + platform set), not a partial slice, so the fingerprint tracks
 * exactly what a turn-to-turn change would alter.
 */
export function computeToolFingerprint(tools: ToolDefinition[] | undefined): string {
	if (!tools || tools.length === 0) return "empty";

	// Defensive: skip any malformed entry without a function definition. The
	// fingerprint is a cache-keying hint — a bad entry must degrade the hash,
	// never throw and abort the agent loop.
	const valid = tools.filter((t) => t?.function?.name !== undefined);
	if (valid.length === 0) return "empty";

	// Sort by tool name for determinism, then stringify.
	// Bytewise, not localeCompare: the fingerprint must be identical across
	// hosts regardless of ICU locale, or warm-path tool-set comparison and
	// cross-host delegation would see phantom tool changes.
	const sorted = [...valid].sort((a, b) => compareBytewise(a.function.name, b.function.name));

	const key = sorted
		.map((t) => `${t.function.name}:${JSON.stringify(canonicalize(t.function.parameters))}`)
		.join("|");

	// Use Bun's CryptoHasher for SHA256
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(key);
	return hasher.digest("hex").slice(0, 16);
}
