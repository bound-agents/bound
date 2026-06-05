import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

/**
 * Minimal structural type for content blocks.
 * Satisfied by ContentBlock from @bound/llm without requiring the import.
 */
interface TokenCountableBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

let encoding: Tiktoken | null = null;

function getEncoding(): Tiktoken {
	if (!encoding) {
		encoding = new Tiktoken(cl100k_base);
	}
	return encoding;
}

/**
 * Bounded LRU cache for token counts, keyed on the exact input string.
 *
 * `js-tiktoken/lite` is a pure-JS BPE tokenizer that runs at a flat
 * ~8k chars/sec regardless of content. Context assembly counts the same
 * message content several times per cold rebuild (budget validation,
 * truncation, metric recording), and re-counts the full thread history on
 * every cold-cache turn — so identical strings are re-encoded constantly.
 * Memoizing the count is lossless (token count is a pure function of the
 * string) and collapses those repeats to a single encode.
 *
 * The cache is bounded by entry count (Map insertion order = LRU; a hit
 * refreshes recency, overflow evicts the oldest). Entry count rather than
 * byte size keeps the bound simple; tool-result content is already capped
 * upstream (≤50k chars per stream / ≤256 KiB per result), so worst-case
 * footprint stays modest.
 */
const TOKEN_CACHE_MAX = 1024;
const tokenCache = new Map<string, number>();
let tokenCacheHits = 0;
let tokenCacheMisses = 0;

function memoizedEncodeLength(text: string): number {
	const cached = tokenCache.get(text);
	if (cached !== undefined) {
		// Refresh LRU recency: re-insert moves the key to the newest position.
		tokenCache.delete(text);
		tokenCache.set(text, cached);
		tokenCacheHits++;
		return cached;
	}
	const count = getEncoding().encode(text).length;
	tokenCache.set(text, count);
	tokenCacheMisses++;
	if (tokenCache.size > TOKEN_CACHE_MAX) {
		const oldest = tokenCache.keys().next().value;
		if (oldest !== undefined) tokenCache.delete(oldest);
	}
	return count;
}

/**
 * Count tokens in a plain text string using cl100k_base encoding.
 * Labeled "estimated" in UI because cl100k_base approximates Claude's tokenizer (~5-10% variance).
 * Returns 0 for empty strings. Results are memoized (see {@link memoizedEncodeLength}).
 */
export function countTokens(text: string): number {
	if (text.length === 0) return 0;
	return memoizedEncodeLength(text);
}

/**
 * Count tokens in message content (string or content block array).
 * For text blocks, counts tokens of the text content.
 * For other block types (tool_use, image, document), counts tokens of the JSON representation.
 */
export function countContentTokens(content: string | TokenCountableBlock[]): number {
	if (typeof content === "string") return countTokens(content);
	return content.reduce((sum, block) => {
		if (block.type === "text" && typeof block.text === "string")
			return sum + countTokens(block.text);
		return sum + countTokens(JSON.stringify(block));
	}, 0);
}

/**
 * Test-only introspection into the token-count memoization cache.
 * Not part of the public token-counting contract; exposed so tests can
 * assert cache behavior deterministically rather than via flaky timing.
 */
export function __tokenCacheStats(): {
	size: number;
	hits: number;
	misses: number;
	has(text: string): boolean;
} {
	return {
		size: tokenCache.size,
		hits: tokenCacheHits,
		misses: tokenCacheMisses,
		has: (text: string) => tokenCache.has(text),
	};
}
