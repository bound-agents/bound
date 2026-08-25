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
 * The cache is bounded by total cached CONTENT BYTES (sum of key string
 * lengths), not entry count. A prior 1024-ENTRY bound thrashed on large
 * threads: a thread with >1024 distinct message contents (observed: 1,623
 * distinct on a 1,640-message thread; 39k+ on the largest) overflowed the
 * cache within a single full-history pass, dropping the hit rate to ~1%.
 * Every one of the ~4-8 full-history token passes per cold assembly then
 * re-encoded the entire multi-MB history from scratch (~1.5s/pass), pegging
 * a CPU core for 80-110s. A byte bound sized above a realistic thread's
 * distinct-content footprint keeps the whole working set resident so the hit
 * rate stays high across every pass, while still capping worst-case memory
 * (Map insertion order = LRU; a hit refreshes recency, overflow evicts oldest
 * until back under budget).
 */
const TOKEN_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const tokenCache = new Map<string, number>();
let tokenCacheBytes = 0;
let tokenCacheHits = 0;
let tokenCacheMisses = 0;
const encodedTexts: string[] = [];
let encodeObserver: ((text: string) => void) | undefined;

function memoizedEncodeLength(text: string): number {
	const cached = tokenCache.get(text);
	if (cached !== undefined) {
		// Refresh LRU recency: re-insert moves the key to the newest position.
		tokenCache.delete(text);
		tokenCache.set(text, cached);
		tokenCacheHits++;
		return cached;
	}
	encodedTexts.push(text);
	encodeObserver?.(text);
	const count = getEncoding().encode(text).length;
	tokenCache.set(text, count);
	tokenCacheBytes += text.length;
	tokenCacheMisses++;
	// Evict oldest entries until back under the byte budget. A single entry
	// larger than the whole budget is still cached (then immediately evicted on
	// the next insert) rather than looping forever.
	while (tokenCacheBytes > TOKEN_CACHE_MAX_BYTES && tokenCache.size > 1) {
		const oldest = tokenCache.keys().next().value;
		if (oldest === undefined) break;
		tokenCache.delete(oldest);
		tokenCacheBytes -= oldest.length;
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
 * Fixed token estimate for an inline image/document block, in lieu of running
 * tiktoken over its base64 payload.
 *
 * A block's `source.data` holds base64 bytes (often multiple MB). Feeding that
 * to the BPE tokenizer is BOTH wrong and catastrophically slow: base64
 * tokenizes at roughly one token per character, so a 5 MB image would report
 * ~5M "tokens" and take tens of seconds through the pure-JS encoder (observed:
 * a single cold assembly with 37 hydrated file_ref blocks spent 51s here). The
 * model does not bill an image by its base64 length anyway — vision models use
 * a fixed per-image/tile formula. This flat estimate is a coarse stand-in that
 * keeps the budget gate roughly honest without the pathological encode. The
 * exact value is not load-bearing (the estimate already carries ±10-15%
 * cl100k-vs-real variance and a downstream safety margin); it just must not be
 * the base64 length.
 */
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1_600;

/**
 * Count tokens in message content (string or content block array).
 * For text blocks, counts tokens of the text content.
 * For image/document blocks, uses a fixed estimate (see
 * {@link IMAGE_BLOCK_TOKEN_ESTIMATE}) rather than tokenizing the base64 payload.
 * For other block types (tool_use, etc.), counts tokens of the JSON representation.
 */
export function countContentTokens(content: string | TokenCountableBlock[]): number {
	if (typeof content === "string") return countTokens(content);
	return content.reduce((sum, block) => {
		if (block.type === "text" && typeof block.text === "string")
			return sum + countTokens(block.text);
		// Never tokenize an image/document base64 payload — see
		// IMAGE_BLOCK_TOKEN_ESTIMATE. Count the small structural fields (type,
		// media_type, title, filename, description) so those still register, but
		// omit the `source`/`data` bytes.
		if (block.type === "image" || block.type === "document") {
			const { source, data, ...rest } = block as TokenCountableBlock & {
				source?: unknown;
				data?: unknown;
			};
			return sum + IMAGE_BLOCK_TOKEN_ESTIMATE + countTokens(JSON.stringify(rest));
		}
		return sum + countTokens(JSON.stringify(block));
	}, 0);
}

/**
 * Per-message token-count cache keyed by message IDENTITY — `${id} ${modifiedAt}`
 * — rather than by content bytes.
 *
 * The content cache above is defeated by cross-thread churn: a large thread's
 * distinct contents (multi-MB) get evicted from the 64 MB byte budget as soon
 * as a few OTHER large threads are counted, so the next COLD context rebuild of
 * that thread re-encodes its entire history from scratch (measured: hit rate
 * back to ~1%, ~2s per full-history pass, pegging a core for ~100s on the
 * biggest threads). Because assembly loads the full thread and tokenizes it to
 * decide truncation, this fires on every cold rebuild.
 *
 * Keying on `(id, modifiedAt)` makes each entry tiny (a UUID + int, ~50 bytes
 * vs multi-KB content), so this cache holds ~100x more messages in the same
 * memory and survives cross-thread churn. Messages are append-only and their
 * content is immutable EXCEPT redaction, which bumps `modified_at` (see
 * redaction.ts) — so folding `modifiedAt` into the key auto-invalidates a
 * redacted message. A message is thus tiktoken-encoded once ever (until
 * redacted), not once per cold rebuild.
 *
 * Bounded by ENTRY COUNT (safe because entries are tiny and fixed-size, unlike
 * variable-length content). LRU: a hit refreshes recency; overflow evicts the
 * oldest.
 *
 * The cap must exceed the cluster's total live message count, or a single large
 * thread's rebuild evicts another thread's entries and the cross-thread-churn
 * survival property is lost. At ~60 bytes/entry (UUID key + int), 500k entries
 * is ~30 MB worst case — comparable to the content cache but far more useful,
 * since these entries are tiny and identity-stable rather than multi-KB content.
 * (Observed live: ~309k total messages; the largest thread ~40k.)
 */
const TOKEN_ID_CACHE_MAX = 500_000;
const tokenIdCache = new Map<string, number>();
let tokenIdCacheHits = 0;
let tokenIdCacheMisses = 0;

/**
 * Count tokens for a message's content, memoized by message identity.
 * Lossless: on a miss it delegates to `countContentTokens` (which itself
 * memoizes the raw encode by content), so the returned count is identical to
 * calling `countContentTokens(content)` directly.
 *
 * `id` and `modifiedAt` come from the `messages` row. Callers that lack a
 * stable identity (freshly-built injected messages) should call
 * `countContentTokens` directly instead.
 */
export function countContentTokensById(
	id: string,
	modifiedAt: string,
	content: string | TokenCountableBlock[],
): number {
	const key = `${id} ${modifiedAt}`;
	const cached = tokenIdCache.get(key);
	if (cached !== undefined) {
		tokenIdCache.delete(key);
		tokenIdCache.set(key, cached);
		tokenIdCacheHits++;
		return cached;
	}
	const count = countContentTokens(content);
	tokenIdCache.set(key, count);
	tokenIdCacheMisses++;
	if (tokenIdCache.size > TOKEN_ID_CACHE_MAX) {
		const oldest = tokenIdCache.keys().next().value;
		if (oldest !== undefined) tokenIdCache.delete(oldest);
	}
	return count;
}

/**
 * Test-only introspection into the token-count memoization caches.
 * Not part of the public token-counting contract; exposed so tests can
 * assert cache behavior deterministically rather than via flaky timing.
 */
export function __tokenCacheStats(): {
	size: number;
	bytes: number;
	maxBytes: number;
	hits: number;
	misses: number;
	encodedTexts: readonly string[];
	has(text: string): boolean;
	idSize: number;
	idMaxEntries: number;
	idHits: number;
	idMisses: number;
	hasId(id: string, modifiedAt: string): boolean;
	setEncodeObserver(observer: ((text: string) => void) | undefined): void;
} {
	return {
		size: tokenCache.size,
		bytes: tokenCacheBytes,
		maxBytes: TOKEN_CACHE_MAX_BYTES,
		hits: tokenCacheHits,
		misses: tokenCacheMisses,
		encodedTexts,
		has: (text: string) => tokenCache.has(text),
		idSize: tokenIdCache.size,
		idMaxEntries: TOKEN_ID_CACHE_MAX,
		idHits: tokenIdCacheHits,
		idMisses: tokenIdCacheMisses,
		hasId: (id: string, modifiedAt: string) => tokenIdCache.has(`${id} ${modifiedAt}`),
		setEncodeObserver: (observer) => {
			encodeObserver = observer;
		},
	};
}
