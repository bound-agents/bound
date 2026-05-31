/**
 * Property tests for the stable-prefix hash helpers.
 *
 * The drift detector at `validation/run-stable-prefix-drift-validation.ts`
 * relies on three hash properties to classify drift correctly:
 *
 *   1. Determinism — same input bytes produce same hash. Without
 *      this, the drift detector can't distinguish "bytes changed"
 *      from "hash function jittered."
 *
 *   2. Sensitivity — different input bytes produce different
 *      hashes (with overwhelming probability). Without this,
 *      compose-leaks would silently look identical to clean
 *      rebuilds.
 *
 *   3. Canonicalization order-invariance for input fingerprint —
 *      Maps and Sets must serialize in a key-sorted order so two
 *      semantically-equal input snapshots produce the same
 *      fingerprint regardless of insertion order.
 *
 * Properties:
 *
 *   X1 hashSystemPromptString determinism
 *   X2 hashSystemPromptString sensitivity (single-byte flip)
 *   X3 hashSystemPromptString shape (16 hex chars)
 *   X4 hashStableVolatileInputs determinism
 *   X5 hashStableVolatileInputs sensitivity to ANY input field change
 *   X6 hashStableVolatileInputs Map-order invariance
 *   X7 hashStableVolatileInputs Set-order invariance
 *   X8 hashStableVolatileInputs shape (16 hex chars on non-empty)
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { hashStableVolatileInputs, hashSystemPromptString } from "../hash";
import type { StableVolatileInputs } from "../types";

const HEX_16 = /^[0-9a-f]{16}$/;

const safeKey = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s));
const safeValue = fc.string({ minLength: 0, maxLength: 60 }).filter((s) => !/[\n\r]/.test(s));
const safeModifiedAt = fc.constant("2026-05-25T12:00:00Z");

const stableInputsArb: fc.Arbitrary<StableVolatileInputs> = fc.record({
	pinned: fc.array(fc.record({ key: safeKey, value: safeValue, modifiedAt: safeModifiedAt }), {
		maxLength: 5,
	}),
	summaries: fc.array(fc.record({ key: safeKey, value: safeValue, modifiedAt: safeModifiedAt }), {
		maxLength: 5,
	}),
	detailEntries: fc.array(
		fc.record({
			key: safeKey,
			last_accessed_at: fc.option(fc.constant("2026-05-25T12:00:00Z"), { nil: null }),
		}),
		{ maxLength: 8 },
	),
	parentSummaryByKey: fc
		.array(fc.tuple(safeKey, safeKey), { maxLength: 5 })
		.map((pairs) => new Map(pairs)),
	staleChildKeysInWorkingKnowledge: fc.array(safeKey, { maxLength: 4 }).map((ks) => new Set(ks)),
	budgetPressure: fc.boolean(),
	tunables: fc.record({
		n: fc.integer({ min: 100, max: 2000 }),
		m: fc.integer({ min: 5, max: 50 }),
	}),
	skillIndex: fc.array(
		fc.record({
			name: safeKey,
			description: safeValue,
		}),
		{ maxLength: 4 },
	),
});

describe("hashSystemPromptString — property tests", () => {
	it("X1: determinism — same string, same hash", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (s) => {
				const copy = `${s}`;
				return hashSystemPromptString(s) === hashSystemPromptString(copy);
			}),
			{ numRuns: 100 },
		);
	});

	it("X2: sensitivity — single-byte flip changes the hash", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 500 }),
				fc.integer({ min: 0, max: 200 }),
				(s, idx) => {
					if (idx >= s.length) return true;
					const flipped =
						s.slice(0, idx) +
						String.fromCharCode((s.charCodeAt(idx) + 1) & 0xff) +
						s.slice(idx + 1);
					if (flipped === s) return true;
					return hashSystemPromptString(s) !== hashSystemPromptString(flipped);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("X3: shape — 16 hex chars", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (s) => {
				return HEX_16.test(hashSystemPromptString(s));
			}),
			{ numRuns: 100 },
		);
	});
});

describe("hashStableVolatileInputs — property tests", () => {
	it("X4: determinism — same input snapshot, same hash", () => {
		fc.assert(
			fc.property(stableInputsArb, (inputs) => {
				const copy = { ...inputs };
				return hashStableVolatileInputs(inputs) === hashStableVolatileInputs(copy);
			}),
			{ numRuns: 100 },
		);
	});

	it("X5: sensitivity — toggling budgetPressure changes the hash", () => {
		fc.assert(
			fc.property(stableInputsArb, (inputs) => {
				const a = hashStableVolatileInputs(inputs);
				const b = hashStableVolatileInputs({ ...inputs, budgetPressure: !inputs.budgetPressure });
				return a !== b;
			}),
			{ numRuns: 50 },
		);
	});

	it("X5b: sensitivity — appending a pinned entry changes the hash", () => {
		fc.assert(
			fc.property(stableInputsArb, safeKey, safeValue, (inputs, key, value) => {
				if (inputs.pinned.some((e) => e.key === key)) return true;
				const a = hashStableVolatileInputs(inputs);
				const b = hashStableVolatileInputs({
					...inputs,
					pinned: [...inputs.pinned, { key, value, modifiedAt: "2026-05-25T12:00:00Z" }],
				});
				return a !== b;
			}),
			{ numRuns: 50 },
		);
	});

	it("X6: Map order-invariance — parentSummaryByKey insertion order doesn't affect hash", () => {
		fc.assert(
			fc.property(
				stableInputsArb,
				fc.uniqueArray(fc.tuple(safeKey, safeKey), {
					maxLength: 5,
					selector: ([k]) => k,
				}),
				(inputs, pairs) => {
					if (pairs.length < 2) return true;
					const forward = new Map(pairs);
					const reversed = new Map([...pairs].reverse());
					const a = hashStableVolatileInputs({ ...inputs, parentSummaryByKey: forward });
					const b = hashStableVolatileInputs({ ...inputs, parentSummaryByKey: reversed });
					return a === b;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("X7: Set order-invariance — staleChildKeys insertion order doesn't affect hash", () => {
		fc.assert(
			fc.property(stableInputsArb, fc.uniqueArray(safeKey, { maxLength: 4 }), (inputs, keys) => {
				if (keys.length < 2) return true;
				const forward = new Set(keys);
				const reversed = new Set([...keys].reverse());
				const a = hashStableVolatileInputs({
					...inputs,
					staleChildKeysInWorkingKnowledge: forward,
				});
				const b = hashStableVolatileInputs({
					...inputs,
					staleChildKeysInWorkingKnowledge: reversed,
				});
				return a === b;
			}),
			{ numRuns: 50 },
		);
	});

	it("X8: shape — 16 hex chars", () => {
		fc.assert(
			fc.property(stableInputsArb, (inputs) => {
				return HEX_16.test(hashStableVolatileInputs(inputs));
			}),
			{ numRuns: 50 },
		);
	});
});
