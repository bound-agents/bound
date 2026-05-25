/**
 * Hash helpers for stable-prefix drift detection.
 *
 * Two separable hashes feed the validator at
 * `validation/run-stable-prefix-drift-validation.ts`:
 *
 *   1. **Output hash** — SHA-256/16-hex of the system-prompt byte
 *      string that actually rides the cache breakpoint. Two
 *      consecutive cold rebuilds within the same cache TTL window
 *      with byte-identical system params share the same hash and
 *      hit the provider's prefix cache.
 *
 *   2. **Input fingerprint** — SHA-256/16-hex of a deterministic
 *      canonicalization of `StableVolatileInputs`. When two cold
 *      rebuilds produce different output hashes but matching input
 *      fingerprints, the divergence cannot have come from a declared
 *      input change — by elimination, the renderer is reading some
 *      undeclared signal (e.g., wall-clock, `process.env`, etc.).
 *      That points the smoking gun straight at `compose.ts` /
 *      delegated renderers without needing log scraping.
 *
 * Hashing strategy mirrors `computeToolFingerprint` in
 * `cached-turn-state.ts`: `Bun.CryptoHasher("sha256")` digest, hex
 * output, truncated to 16 chars. 16 hex chars = 64 bits which is
 * comfortably above the birthday-bound for the per-thread window the
 * detector compares (≤ a few hundred turns/day), and the truncation
 * keeps `context_debug` row growth negligible.
 */

import type { StableVolatileInputs } from "./types";

/**
 * Length of the truncated hex digest stored on `context_debug`.
 * 16 chars = 64 bits.
 */
const HASH_HEX_LENGTH = 16;

/**
 * Compute the SHA-256/16-hex hash of an arbitrary string. Used by
 * the agent loop's cold path to fingerprint the final `systemPrompt`
 * byte string post-`systemParts.join("\n\n")`.
 */
export function hashSystemPromptString(systemPrompt: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(systemPrompt);
	return hasher.digest("hex").slice(0, HASH_HEX_LENGTH);
}

/**
 * Compute the SHA-256/16-hex hash of a deterministic canonicalization
 * of `StableVolatileInputs`.
 *
 * Canonicalization rules — these matter because two byte-equivalent
 * input snapshots must produce the same fingerprint regardless of
 * insertion order or object identity:
 *
 *   - Arrays: kept in their existing order. Upstream loaders
 *     (`loadPinnedEntries`, `loadDetailEntries`) already produce
 *     deterministic orders by SQL `ORDER BY`, and the renderer
 *     consumes the order verbatim. Re-sorting here would mask
 *     order-dependent leaks in the renderer (a bug we'd want to
 *     surface, not paper over).
 *
 *   - Maps and Sets: serialized as sorted key arrays. Iteration
 *     order on these is insertion-order in JS, which would otherwise
 *     leak source-side ordering accidents into the fingerprint.
 *
 *   - Booleans / numbers / strings: passed through.
 */
export function hashStableVolatileInputs(inputs: StableVolatileInputs): string {
	const canonical = canonicalizeInputs(inputs);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(JSON.stringify(canonical));
	return hasher.digest("hex").slice(0, HASH_HEX_LENGTH);
}

interface CanonicalInputs {
	pinned: ReadonlyArray<{ key: string; value: string }>;
	summaries: ReadonlyArray<{ key: string; value: string }>;
	detailEntries: ReadonlyArray<{ key: string; last_accessed_at: string | null }>;
	parentSummaryByKey: ReadonlyArray<[string, string]>;
	staleChildKeysInWorkingKnowledge: ReadonlyArray<string>;
	budgetPressure: boolean;
	tunables: { n: number; m: number };
	skillIndex: ReadonlyArray<{ name: string; description: string }>;
}

function canonicalizeInputs(inputs: StableVolatileInputs): CanonicalInputs {
	return {
		pinned: inputs.pinned.map((e) => ({ key: e.key, value: e.value })),
		summaries: inputs.summaries.map((e) => ({ key: e.key, value: e.value })),
		detailEntries: inputs.detailEntries.map((e) => ({
			key: e.key,
			last_accessed_at: e.last_accessed_at,
		})),
		parentSummaryByKey: sortMapEntries(inputs.parentSummaryByKey),
		staleChildKeysInWorkingKnowledge: sortSet(inputs.staleChildKeysInWorkingKnowledge),
		budgetPressure: inputs.budgetPressure,
		tunables: { n: inputs.tunables.n, m: inputs.tunables.m },
		skillIndex: inputs.skillIndex.map((s) => ({ name: s.name, description: s.description })),
	};
}

function sortMapEntries(map: ReadonlyMap<string, string>): ReadonlyArray<[string, string]> {
	return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function sortSet(set: ReadonlySet<string>): ReadonlyArray<string> {
	return [...set].sort();
}
