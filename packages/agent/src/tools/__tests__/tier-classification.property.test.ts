/**
 * Property tests for memory tier classification.
 *
 * The invariant (CONTRIBUTING.md "Memory tiers"): keys starting with
 * `_standing:` / `_feedback:` / `_policy:` / `_pinned:` ALWAYS resolve
 * to the `pinned` tier, regardless of any explicit tier argument.
 * This prevents operational rules from being demoted by an
 * `args.tier` on store — a class of bug where the agent could
 * accidentally pass `tier: "default"` and lose a standing rule's
 * pinning authority.
 *
 * Properties:
 *
 *   T1 Totality — `resolveTierForKey` returns a valid `MemoryTier`
 *      for any input key, with or without an explicit tier.
 *
 *   T2 Pinned-prefix dominance — for any key matching a pinned
 *      prefix and any explicit-tier argument, the result is always
 *      `"pinned"`. This is the priority-ordering invariant.
 *
 *   T3 Idempotence — `resolveTierForKey(k, resolveTierForKey(k, t))
 *      === resolveTierForKey(k, t)`. Useful when the resolved tier
 *      is fed back in as an explicit argument on a re-store.
 *
 *   T4 Default fallback — for any key WITHOUT a pinned prefix and
 *      WITHOUT an explicit tier, the result is `"default"`. The
 *      "no-explicit-tier" case must not silently grow a different
 *      default.
 *
 *   T5 Explicit-tier passthrough on non-pinned keys — for any
 *      non-pinned-prefix key and any explicit tier, the result
 *      equals the explicit tier.
 *
 *   T6 hasPinnedPrefix is total and decidable on the prefix list —
 *      for any key, returns true iff one of the listed prefixes
 *      is the literal start of the key followed by `:`.
 */

import { describe, it } from "bun:test";
import type { MemoryTier } from "@bound/shared";
import fc from "fast-check";
import { PINNED_PREFIXES, hasPinnedPrefix, resolveTierForKey } from "../memory";

const VALID_TIERS: ReadonlyArray<MemoryTier> = ["pinned", "summary", "default", "detail"];

const tierArb: fc.Arbitrary<MemoryTier> = fc.constantFrom(...VALID_TIERS);

const pinnedPrefixArb = fc.constantFrom(...PINNED_PREFIXES);

const safeKeyTail = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s));

const pinnedKey = fc.tuple(pinnedPrefixArb, safeKeyTail).map(([p, t]) => `${p}:${t}`);

// Non-pinned keys — anything that doesn't start with a pinned prefix + colon.
const nonPinnedKey = fc
	.string({ minLength: 1, maxLength: 60 })
	.filter((s) => !PINNED_PREFIXES.some((p) => s.startsWith(`${p}:`)) && !/[\n\r]/.test(s));

const anyKey = fc.oneof(pinnedKey, nonPinnedKey);

describe("resolveTierForKey — property tests", () => {
	it("T1: totality — returns a valid MemoryTier for any input", () => {
		fc.assert(
			fc.property(anyKey, fc.option(tierArb, { nil: undefined }), (key, explicit) => {
				const result = resolveTierForKey(key, explicit ?? undefined);
				return VALID_TIERS.includes(result);
			}),
			{ numRuns: 200 },
		);
	});

	it("T2: pinned-prefix dominance — pinned-prefix keys always resolve to 'pinned'", () => {
		fc.assert(
			fc.property(pinnedKey, fc.option(tierArb, { nil: undefined }), (key, explicit) => {
				const result = resolveTierForKey(key, explicit ?? undefined);
				return result === "pinned";
			}),
			{ numRuns: 200 },
		);
	});

	it("T3: idempotence — feeding the resolved tier back in is a fixed point", () => {
		fc.assert(
			fc.property(anyKey, fc.option(tierArb, { nil: undefined }), (key, explicit) => {
				const once = resolveTierForKey(key, explicit ?? undefined);
				const twice = resolveTierForKey(key, once);
				return once === twice;
			}),
			{ numRuns: 200 },
		);
	});

	it("T4: default fallback — non-pinned key + no explicit tier => 'default'", () => {
		fc.assert(
			fc.property(nonPinnedKey, (key) => {
				return resolveTierForKey(key) === "default";
			}),
			{ numRuns: 200 },
		);
	});

	it("T5: explicit-tier passthrough on non-pinned keys", () => {
		fc.assert(
			fc.property(nonPinnedKey, tierArb, (key, explicit) => {
				return resolveTierForKey(key, explicit) === explicit;
			}),
			{ numRuns: 200 },
		);
	});

	it("T6: hasPinnedPrefix matches the prefix list and only the prefix list", () => {
		fc.assert(
			fc.property(anyKey, (key) => {
				const expected = PINNED_PREFIXES.some((p) => key.startsWith(`${p}:`));
				return hasPinnedPrefix(key) === expected;
			}),
			{ numRuns: 200 },
		);
	});

	it("T2-regression: explicit tier='default' on _standing:foo still resolves to pinned", () => {
		// This is the exact bug class the priority-ordering invariant
		// defends against: the agent passes an explicit tier and the
		// pinning gets demoted.
		const result = resolveTierForKey("_standing:foo", "default");
		if (result !== "pinned") {
			throw new Error(`Pinned-prefix dominance regressed: got ${result}`);
		}
	});
});
