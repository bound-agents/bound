/**
 * Property tests for `renderNotifications`.
 *
 * Properties:
 *
 *   F1 Determinism — same inputs produce byte-equal output.
 *   F2 Cap — at most ADVISORY_NOTIF_CAP advisory lines.
 *   F3 Dedup — duplicate titles collapse; counts >1 carry " (×N)".
 *   F4 Empty inputs → empty output.
 *   F5 Skill retirement uncapped — every retired-skill row produces a line.
 *   F6 Line-shape — every line has the expected tag prefix.
 *   F7 Order preservation — input order drives output order.
 *   F8 Capture-time — every advisory ack line carries a relative-time
 *      fragment for its resolution, so a stale operator-ack is legible
 *      as stale rather than read as current state (#71).
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import {
	ADVISORY_NOTIF_CAP,
	type ResolvedAdvisoryRow,
	type RetiredSkillRow,
	renderNotifications,
} from "../render";

/** Fixed wall-clock anchor so relative-time output is deterministic in tests. */
const NOW_MS = 1_700_000_000_000;

const titleArb = fc
	.string({ minLength: 1, maxLength: 16 })
	.filter((s) => !/[\n\r]/.test(s) && !s.includes("'"));
const reasonArb = fc.option(
	fc.string({ minLength: 0, maxLength: 24 }).filter((s) => !/[\n\r"]/.test(s)),
	{ nil: null },
);
const statusArb = fc.constantFrom("approved", "applied", "dismissed");
// Resolution timestamps within the prior 24h window (the loader's cutoff).
const resolvedAtArb = fc
	.integer({ min: 0, max: 24 * 60 * 60 * 1000 })
	.map((agoMs) => new Date(NOW_MS - agoMs).toISOString());

const skillArb: fc.Arbitrary<RetiredSkillRow> = fc.record({
	name: titleArb,
	retired_reason: reasonArb,
});

const advisoryArb: fc.Arbitrary<ResolvedAdvisoryRow> = fc.record({
	title: titleArb,
	status: statusArb,
	resolvedAt: resolvedAtArb,
});

describe("renderNotifications — property tests", () => {
	it("F1: determinism — same inputs produce byte-equal output", () => {
		fc.assert(
			fc.property(
				fc.array(skillArb, { maxLength: 8 }),
				fc.array(advisoryArb, { maxLength: 16 }),
				(retiredSkills, resolvedAdvisories) => {
					const a = renderNotifications({
						retiredSkills,
						resolvedAdvisories,
						nowMs: NOW_MS,
					}).join("\n");
					const b = renderNotifications({
						retiredSkills,
						resolvedAdvisories,
						nowMs: NOW_MS,
					}).join("\n");
					return a === b;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("F2: cap — never emits more than ADVISORY_NOTIF_CAP advisory lines", () => {
		fc.assert(
			fc.property(fc.array(advisoryArb, { maxLength: 30 }), (resolvedAdvisories) => {
				const out = renderNotifications({ retiredSkills: [], resolvedAdvisories, nowMs: NOW_MS });
				const advLines = out.filter((l) => l.startsWith("[Advisory notification]"));
				return advLines.length <= ADVISORY_NOTIF_CAP;
			}),
			{ numRuns: 100 },
		);
	});

	it("F3: dedup — N copies of same (title,status) collapse to one line with (×N)", () => {
		fc.assert(
			fc.property(
				titleArb,
				statusArb,
				resolvedAtArb,
				fc.integer({ min: 2, max: 10 }),
				(title, status, resolvedAt, count) => {
					const advisories = Array.from({ length: count }, () => ({ title, status, resolvedAt }));
					const out = renderNotifications({
						retiredSkills: [],
						resolvedAdvisories: advisories,
						nowMs: NOW_MS,
					});
					if (out.length !== 1) throw new Error(`expected 1 line, got ${out.length}`);
					if (!out[0].includes(`(×${count})`)) {
						throw new Error(`expected count marker (×${count}) in: ${out[0]}`);
					}
					return true;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("F3b: single advisory has no count marker", () => {
		fc.assert(
			fc.property(advisoryArb, (advisory) => {
				const out = renderNotifications({
					retiredSkills: [],
					resolvedAdvisories: [advisory],
					nowMs: NOW_MS,
				});
				if (out.length !== 1) return false;
				return !out[0].includes("(×");
			}),
			{ numRuns: 50 },
		);
	});

	it("F4: empty inputs → empty output", () => {
		const out = renderNotifications({ retiredSkills: [], resolvedAdvisories: [], nowMs: NOW_MS });
		if (out.length !== 0) throw new Error(`expected empty, got ${out.length} lines`);
	});

	it("F5: skill retirement is uncapped — every input row produces a line", () => {
		fc.assert(
			fc.property(
				fc.array(skillArb, { minLength: 0, maxLength: 50 }).map((skills) => {
					// Force unique names so dedup-style logic, if accidentally added,
					// would fail this property.
					return skills.map((s, i) => ({ ...s, name: `${s.name}-${i}` }));
				}),
				(retiredSkills) => {
					const out = renderNotifications({ retiredSkills, resolvedAdvisories: [], nowMs: NOW_MS });
					return out.length === retiredSkills.length;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("F6: every emitted line has the expected tag prefix", () => {
		fc.assert(
			fc.property(
				fc.array(skillArb, { maxLength: 6 }),
				fc.array(advisoryArb, { maxLength: 12 }),
				(retiredSkills, resolvedAdvisories) => {
					const out = renderNotifications({ retiredSkills, resolvedAdvisories, nowMs: NOW_MS });
					for (const line of out) {
						if (
							!line.startsWith("[Skill notification]") &&
							!line.startsWith("[Advisory notification]")
						) {
							return false;
						}
					}
					return true;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("F7: order preservation — skill rows precede advisory rows; input order kept within each group", () => {
		fc.assert(
			fc.property(
				fc
					.array(skillArb, { minLength: 1, maxLength: 4 })
					.map((skills) => skills.map((s, i) => ({ ...s, name: `s${i}-${s.name}` }))),
				fc
					.array(advisoryArb, { minLength: 1, maxLength: 4 })
					.map((advs) => advs.map((a, i) => ({ ...a, title: `t${i}-${a.title}` }))),
				(retiredSkills, resolvedAdvisories) => {
					const out = renderNotifications({ retiredSkills, resolvedAdvisories, nowMs: NOW_MS });
					// Skill lines come first.
					const firstAdvIdx = out.findIndex((l) => l.startsWith("[Advisory notification]"));
					if (firstAdvIdx !== -1) {
						for (let i = 0; i < firstAdvIdx; i++) {
							if (!out[i].startsWith("[Skill notification]")) return false;
						}
					}
					// Within skill block, names appear in input order.
					for (let i = 0; i < retiredSkills.length; i++) {
						if (!out[i].includes(`'${retiredSkills[i].name}'`)) return false;
					}
					return true;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("F-cap-exact: with > CAP distinct titles, exactly CAP advisory lines emitted", () => {
		const advisories: ResolvedAdvisoryRow[] = Array.from(
			{ length: ADVISORY_NOTIF_CAP + 5 },
			(_, i) => ({
				title: `unique-${i}`,
				status: "applied",
				resolvedAt: new Date(NOW_MS).toISOString(),
			}),
		);
		const out = renderNotifications({
			retiredSkills: [],
			resolvedAdvisories: advisories,
			nowMs: NOW_MS,
		});
		if (out.length !== ADVISORY_NOTIF_CAP) {
			throw new Error(`expected ${ADVISORY_NOTIF_CAP} lines, got ${out.length}`);
		}
	});

	it("F8: every advisory ack line carries a relative-time capture fragment", () => {
		fc.assert(
			fc.property(fc.array(advisoryArb, { minLength: 1, maxLength: 12 }), (resolvedAdvisories) => {
				const out = renderNotifications({ retiredSkills: [], resolvedAdvisories, nowMs: NOW_MS });
				const advLines = out.filter((l) => l.startsWith("[Advisory notification]"));
				for (const line of advLines) {
					// A capture-time fragment is "just now" or "Nm/h/d ago".
					if (!/(just now|\d+[mhd] ago)/.test(line)) {
						throw new Error(`ack line missing capture-time fragment: ${line}`);
					}
				}
				return true;
			}),
			{ numRuns: 100 },
		);
	});

	it("F8b: ack line renders the correct fragment for a known resolution time", () => {
		const out = renderNotifications({
			retiredSkills: [],
			resolvedAdvisories: [
				{
					title: "stale-thing",
					status: "dismissed",
					resolvedAt: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
				},
			],
			nowMs: NOW_MS,
		});
		if (out.length !== 1) throw new Error(`expected 1 line, got ${out.length}`);
		if (!out[0].includes("3h ago")) {
			throw new Error(`expected "3h ago" in: ${out[0]}`);
		}
		// Order: "...by operator 3h ago." with no count marker for a single row.
		if (!/was dismissed by operator 3h ago\.$/.test(out[0])) {
			throw new Error(`unexpected line shape: ${out[0]}`);
		}
	});

	it("F8c: capture fragment precedes the (×N) count marker", () => {
		const resolvedAt = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
		const out = renderNotifications({
			retiredSkills: [],
			resolvedAdvisories: [
				{ title: "dup", status: "applied", resolvedAt },
				{ title: "dup", status: "applied", resolvedAt },
			],
			nowMs: NOW_MS,
		});
		if (out.length !== 1) throw new Error(`expected 1 line, got ${out.length}`);
		if (!/was applied by operator 5m ago \(×2\)\.$/.test(out[0])) {
			throw new Error(`unexpected line shape: ${out[0]}`);
		}
	});
});
