/**
 * Hash helpers for stable-prefix drift detection.
 *
 * Two separable hashes feed the validator at
 * `validation/run-stable-prefix-drift-validation.ts`:
 *
 *   1. **Output hash** — SHA-256/16-hex of the stable volatile
 *      subsection bytes actually sent on this rebuild
 *      (`stableSubsectionHash`). The fingerprint below covers exactly
 *      the inputs those bytes depend on, so the two are comparable.
 *      The whole-prompt hash (`stablePrefixHash`) is recorded too, but
 *      persona, command registry, and suffix edits move it without
 *      moving the fingerprint, so the detector does not compare it.
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

import { compareBytewise } from "@bound/shared";
import type { StableVolatileInputs } from "./types";

/**
 * Generation tag recorded as `ContextDebugInfo.stablePrefixDriftVersion`
 * beside `stableSubsectionHash` and `stablePrefixInputFingerprint`. The
 * drift detector compares only turns carrying the current value, so a
 * change to the renderer, the fingerprint canonicalization, or the scope
 * either one covers must bump this constant — otherwise records from two
 * generations would be paired and any difference would read as a leak.
 *
 * Version 2: the compared output hash covers only the stable volatile
 * subsection (not the whole system prompt), and cached bytes are paired
 * with the fingerprint of the inputs that rendered them (#303).
 *
 * Version 3: the per-thread cache and the cold path render through one
 * renderer (stripped `_summary:` cluster names, skill index from the live
 * skills table, no empty `<available_skills>` block).
 */
export const STABLE_PREFIX_DRIFT_VERSION = 3;

/**
 * Length of the truncated hex digest stored on `context_debug`.
 * 16 chars = 64 bits.
 */
const HASH_HEX_LENGTH = 16;

/**
 * Compute the SHA-256/16-hex hash of an arbitrary string. Used by
 * the agent loop's cold path to hash the final `systemPrompt` and the
 * stable volatile subsection bytes.
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
	pinned: ReadonlyArray<{ key: string; value: string; modifiedAt: string }>;
	summaries: ReadonlyArray<{ key: string; value: string; modifiedAt: string }>;
	detailEntries: ReadonlyArray<{ key: string; last_accessed_at: string | null }>;
	parentSummaryByKey: ReadonlyArray<[string, string]>;
	staleChildKeysInWorkingKnowledge: ReadonlyArray<string>;
	budgetPressure: boolean;
	tunables: { n: number; m: number };
	skillIndex: ReadonlyArray<{ name: string; description: string }>;
	clusterModels: ReadonlyArray<{ name: string; hosts: ReadonlyArray<string>; local: boolean }>;
}

function canonicalizeInputs(inputs: StableVolatileInputs): CanonicalInputs {
	return {
		// `modifiedAt` participates in the fingerprint because the `(modified
		// YYYY-MM-DD)` prefix it drives (#71) is part of the rendered stable
		// bytes — omitting it would make a body-rewrite that shifts the
		// calendar date advance the output hash without advancing the input
		// fingerprint, which the drift detector would misclassify as a
		// renderer (compose) leak.
		pinned: inputs.pinned.map((e) => ({ key: e.key, value: e.value, modifiedAt: e.modifiedAt })),
		summaries: inputs.summaries.map((e) => ({
			key: e.key,
			value: e.value,
			modifiedAt: e.modifiedAt,
		})),
		detailEntries: inputs.detailEntries.map((e) => ({
			key: e.key,
			last_accessed_at: e.last_accessed_at,
		})),
		parentSummaryByKey: sortMapEntries(inputs.parentSummaryByKey),
		staleChildKeysInWorkingKnowledge: sortSet(inputs.staleChildKeysInWorkingKnowledge),
		budgetPressure: inputs.budgetPressure,
		tunables: { n: inputs.tunables.n, m: inputs.tunables.m },
		skillIndex: inputs.skillIndex.map((s) => ({ name: s.name, description: s.description })),
		// Cluster model topology drives the `<stable-context>` section. Arrays
		// are pre-sorted upstream (bytewise by name, hosts bytewise within each)
		// so order is already canonical; we copy verbatim like `pinned`/`summaries`
		// rather than re-sort, surfacing any upstream ordering bug rather than
		// papering over it.
		clusterModels: inputs.clusterModels.map((m) => ({
			name: m.name,
			hosts: [...m.hosts],
			local: m.local,
			// Decision metadata is byte-influencing (renderClusterModels emits it
			// as attributes), so it must ride the fingerprint: omitting it would
			// classify a metadata-driven rerender as a compose leak. `?? null`
			// keeps JSON.stringify from dropping absent fields, so "undefined" and
			// "absent" canonicalize identically.
			// Slice 6 (R-MC12): `tier` is retired; `role` joins the byte-influencing
			// set. Pricing is NOT here: the production collector cannot populate
			// `inputPerM`/`outputPerM` (no pricing in the `hosts.models` payload), so
			// the renderer never emits a price attribute for it to fingerprint.
			contextWindow: m.contextWindow ?? null,
			maxOutput: m.maxOutput ?? null,
			vision: m.vision ?? null,
			thinking: m.thinking ?? null,
			role: m.role ?? null,
		})),
	};
}

function sortMapEntries(map: ReadonlyMap<string, string>): ReadonlyArray<[string, string]> {
	return [...map.entries()].sort((a, b) => compareBytewise(a[0], b[0]));
}

function sortSet(set: ReadonlySet<string>): ReadonlyArray<string> {
	return [...set].sort(compareBytewise);
}
