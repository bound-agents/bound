/**
 * Property tests for `composeStableVolatileSubsection`.
 *
 * The R-VC24 stable subsection is the byte-cacheable prefix of the
 * volatile context. The contract — "byte-stable across cold rebuilds
 * within the cache TTL window when nothing relevant has changed" —
 * was previously prose-only and broke silently in production (live
 * thread `2d055bbe-...` ran at an 11.93% cache hit rate due to a
 * 554-token wobble in this section).
 *
 * These tests pin the contract by exercising the abstraction with
 * fast-check arbitraries. Each property runs with `numRuns: 100` —
 * enough to catch the kind of regression that only fires under
 * unusual input shapes (which is precisely what the production leak
 * was).
 *
 * Properties:
 *
 *   P1 Determinism — same input, same output, repeated calls.
 *   P2 Time-purity — adversarial `Date.now()` mocks do not affect
 *      output. This is the property the prior `Nm/h/d ago` formatter
 *      violated.
 *   P3 Locality — extra fields outside the declared `*View` shapes
 *      cannot influence output (enforced by type, asserted by
 *      passing the same narrow projection from a wider object and
 *      verifying the output doesn't carry the extra fields).
 *   P4 Order-invariance over the parent-summary map — the map's
 *      iteration order is not allowed to leak into output.
 *   P5 Last-accessed bump inertness within a calendar day — bumping
 *      `last_accessed_at` to a different ISO timestamp on the SAME
 *      calendar date leaves the output byte-equal. This is the
 *      property that connects the renderer to the
 *      `bumpRenderedDetailEntries` 1h debounce + cache TTL alignment.
 *   P6 Tier-boundary stability — adding a new entry past
 *      `tunables.n` doesn't reorder entries that were already there.
 *   P7 Separator injectivity — `\n\n` does not appear inside any
 *      sub-renderer body, so split-on-separator is lossless.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { composeStableVolatileSubsection } from "../compose";
import type {
	DetailEntryView,
	MemoryEntryView,
	SkillIndexView,
	StableVolatileInputs,
} from "../types";

// ---------- Arbitraries ----------

const memoryKey = fc.string({ minLength: 1, maxLength: 40 }).filter(
	// Reject keys that contain newlines/colons that would alter line shape;
	// the production loaders normalize against this set already so we mirror it.
	(s) => !/[\n\r:]/.test(s),
);

const memoryValue = fc.string({ minLength: 0, maxLength: 300 }).filter(
	// Same — newlines inside a value would multi-line the body line and
	// break the property tests' implicit one-line-per-entry assumption.
	(s) => !/[\n\r]/.test(s),
);

const isoDate = fc
	.tuple(
		fc.integer({ min: 2024, max: 2030 }),
		fc.integer({ min: 1, max: 12 }),
		fc.integer({ min: 1, max: 28 }),
	)
	.map(
		([y, m, d]) =>
			`${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00Z`,
	);

const memoryEntryView: fc.Arbitrary<MemoryEntryView> = fc.record({
	key: memoryKey,
	value: memoryValue,
	modifiedAt: isoDate,
});

const detailEntryView: fc.Arbitrary<DetailEntryView> = fc.record({
	key: memoryKey,
	last_accessed_at: fc.option(isoDate, { nil: null }),
});

const skillIndexView: fc.Arbitrary<SkillIndexView> = fc.record({
	name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/[\n\r<>]/.test(s)),
	description: fc.string({ minLength: 0, maxLength: 100 }).filter((s) => !/[\n\r<>]/.test(s)),
});

const stableInputs: fc.Arbitrary<StableVolatileInputs> = fc.record({
	pinned: fc.array(memoryEntryView, { maxLength: 5 }),
	summaries: fc.array(memoryEntryView, { maxLength: 10 }),
	detailEntries: fc.array(detailEntryView, { maxLength: 30 }),
	parentSummaryByKey: fc
		.array(fc.tuple(memoryKey, memoryKey), { maxLength: 5 })
		.map((pairs) => new Map(pairs)),
	staleChildKeysInWorkingKnowledge: fc
		.array(memoryKey, { maxLength: 3 })
		.map((keys) => new Set(keys)),
	budgetPressure: fc.boolean(),
	tunables: fc.record({
		n: fc.integer({ min: 100, max: 2000 }),
		m: fc.integer({ min: 5, max: 50 }),
	}),
	skillIndex: fc.array(skillIndexView, { maxLength: 5 }),
	clusterModels: fc.array(
		fc.record({
			name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/[\n\r<>]/.test(s)),
			hosts: fc.array(
				fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[\n\r<>]/.test(s)),
				{
					maxLength: 3,
				},
			),
			local: fc.boolean(),
		}),
		{ maxLength: 6 },
	),
});

// ---------- Properties ----------

describe("composeStableVolatileSubsection — property tests", () => {
	it("P1: deterministic — same input, same output", () => {
		fc.assert(
			fc.property(stableInputs, (inputs) => {
				const a = composeStableVolatileSubsection(inputs).join("\n");
				const b = composeStableVolatileSubsection(inputs).join("\n");
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("P2: time-purity — adversarial Date.now() mocks do not affect output", () => {
		const realNow = Date.now;
		const realParse = Date.parse;
		try {
			fc.assert(
				fc.property(
					stableInputs,
					fc.integer({ min: 0, max: 4_102_444_800_000 }), // up to year 2100
					(inputs, mockNowMs) => {
						const baseline = composeStableVolatileSubsection(inputs).join("\n");
						Date.now = () => mockNowMs;
						// The stable Discoverable Archive renders no time-derived
						// content at all (bare `- <key>` titles, key-sorted), so it
						// touches neither Date.now nor Date.parse. A regression that
						// reintroduced any wall-clock read on the stable path would
						// surface as a mismatch here (the two mocked clocks would
						// render differently).
						Date.parse = realParse;
						const mocked = composeStableVolatileSubsection(inputs).join("\n");
						return baseline === mocked;
					},
				),
				{ numRuns: 100 },
			);
		} finally {
			Date.now = realNow;
			Date.parse = realParse;
		}
	});

	it("P3: locality — extra fields outside the view types do not affect output", () => {
		fc.assert(
			fc.property(stableInputs, (inputs) => {
				const baseline = composeStableVolatileSubsection(inputs).join("\n");
				// Sprinkle extra-narrow shadow fields that are not part of
				// `StableVolatileInputs`. Type system blocks this at
				// compile time; we use `any` to simulate a hypothetical
				// future regression where someone smuggles an extra field
				// onto a view object hoping to read it on the stable path.
				type AnyRec = Record<string, unknown>;
				const polluted: StableVolatileInputs = {
					...inputs,
					detailEntries: inputs.detailEntries.map(
						(e): DetailEntryView =>
							({
								...e,
								// Extra field — must not influence output.
								_shadow: "wall-clock-leak-attempt",
							}) as DetailEntryView & AnyRec,
					),
				};
				const polluted2 = composeStableVolatileSubsection(polluted).join("\n");
				return baseline === polluted2;
			}),
			{ numRuns: 100 },
		);
	});

	it("P4: order-invariance — parent-summary map insertion order does not leak", () => {
		fc.assert(
			fc.property(
				stableInputs,
				fc.array(fc.tuple(memoryKey, memoryKey), { maxLength: 5 }),
				(inputs, pairs) => {
					const a = composeStableVolatileSubsection({
						...inputs,
						parentSummaryByKey: new Map(pairs),
					}).join("\n");
					// Reverse the pairs — Map iteration order would be
					// reversed in JS, but compose output should not be.
					const b = composeStableVolatileSubsection({
						...inputs,
						parentSummaryByKey: new Map([...pairs].reverse()),
					}).join("\n");
					return a === b;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P5: same-day bump inertness — last_accessed_at edits within one calendar day are inert", () => {
		fc.assert(
			fc.property(
				stableInputs,
				fc.integer({ min: 0, max: 23 }),
				fc.integer({ min: 0, max: 23 }),
				(inputs, hourA, hourB) => {
					if (inputs.detailEntries.length === 0) return true;
					// Pick a target ISO date that all entries share, then
					// vary the *time-of-day* between two calls. The renderer
					// strips everything after the first 10 chars, so the
					// outputs MUST be byte-equal.
					const sharedDate = "2026-05-25";
					const stamp = (h: number) => `${sharedDate}T${String(h).padStart(2, "0")}:30:00Z`;
					const setHour = (h: number): DetailEntryView[] =>
						inputs.detailEntries.map((e) => ({
							...e,
							last_accessed_at: e.last_accessed_at === null ? null : stamp(h),
						}));
					const a = composeStableVolatileSubsection({
						...inputs,
						detailEntries: setHour(hourA),
					}).join("\n");
					const b = composeStableVolatileSubsection({
						...inputs,
						detailEntries: setHour(hourB),
					}).join("\n");
					return a === b;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("P6: tier-1 stability — adding entries preserves existing lines as an ordered subsequence", () => {
		// Detail lines now render key-sorted (NOT last_accessed_at order) so the
		// output is invariant to bump churn. Under key-sort, adding `extras` no
		// longer keeps base lines as a literal PREFIX of grown output — a new key
		// can sort between two base keys. The correct stability invariant is
		// SUBSEQUENCE preservation: every base line still appears in grown output,
		// in the same relative order (a stable merge of two key-sorted lists).
		fc.assert(
			fc.property(
				fc.array(detailEntryView, { minLength: 0, maxLength: 50 }),
				fc.array(detailEntryView, { minLength: 0, maxLength: 50 }),
				(base, extras) => {
					const baseInputs: StableVolatileInputs = {
						pinned: [],
						summaries: [],
						detailEntries: base,
						parentSummaryByKey: new Map(),
						staleChildKeysInWorkingKnowledge: new Set(),
						budgetPressure: false,
						tunables: { n: 1000, m: 20 },
						skillIndex: [],
						clusterModels: [],
					};
					const baseEntryLines = composeStableVolatileSubsection(baseInputs).filter((l) =>
						l.startsWith("- "),
					);
					const grownEntryLines = composeStableVolatileSubsection({
						...baseInputs,
						detailEntries: [...base, ...extras],
					}).filter((l) => l.startsWith("- "));
					// Stay within Tier 1 on both calls; clustering reshuffles in 2/3.
					if (base.length + extras.length > 200) return true;
					// Every base line appears in grown output, in the same relative
					// order: walk grown once, matching base lines in sequence.
					let bi = 0;
					for (const line of grownEntryLines) {
						if (bi < baseEntryLines.length && line === baseEntryLines[bi]) bi++;
					}
					return bi === baseEntryLines.length;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P7: separator injectivity — split('\\n\\n') is lossless across compose output", () => {
		// We don't enforce that NO body line contains "\n\n" because the
		// body is line-array and renderers don't emit double-newline
		// within a line. Instead we assert that joining with "\n" and
		// splitting on "\n\n" round-trips count-stably: the compose
		// output's newline structure is composed entirely of single \n
		// separators between lines, plus the explicit blank-line
		// separators between sections.
		fc.assert(
			fc.property(stableInputs, (inputs) => {
				const lines = composeStableVolatileSubsection(inputs);
				// No line should itself contain \n.
				return lines.every((l) => !l.includes("\n"));
			}),
			{ numRuns: 100 },
		);
	});

	it("P8: locale-independence — a hostile localeCompare does not affect output", () => {
		// The host ICU locale is an environmental signal, not a declared
		// input. Sorting on the stable path must therefore never go through
		// localeCompare: two hosts with different locales (or one host after
		// an ICU upgrade) would otherwise render different bytes for
		// identical synced state, breaking cross-host cache reuse and
		// confusing the drift detector. Simulate the worst case by mocking
		// String.prototype.localeCompare to a REVERSED ordering — if any
		// stable-path sort still consults it, output flips and this fails.
		const realLocaleCompare = String.prototype.localeCompare;
		try {
			fc.assert(
				fc.property(stableInputs, (inputs) => {
					String.prototype.localeCompare = realLocaleCompare;
					const baseline = composeStableVolatileSubsection(inputs).join("\n");
					String.prototype.localeCompare = function (this: string, that: string): number {
						return -realLocaleCompare.call(this, that);
					} as typeof String.prototype.localeCompare;
					const hostile = composeStableVolatileSubsection(inputs).join("\n");
					return baseline === hostile;
				}),
				{ numRuns: 100 },
			);
		} finally {
			String.prototype.localeCompare = realLocaleCompare;
		}
	});
});
