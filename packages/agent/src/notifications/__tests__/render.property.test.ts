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
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import {
	ADVISORY_NOTIF_CAP,
	type ResolvedAdvisoryRow,
	type RetiredSkillRow,
	renderNotifications,
} from "../render";

const titleArb = fc
	.string({ minLength: 1, maxLength: 16 })
	.filter((s) => !/[\n\r]/.test(s) && !s.includes("'"));
const reasonArb = fc.option(
	fc.string({ minLength: 0, maxLength: 24 }).filter((s) => !/[\n\r"]/.test(s)),
	{ nil: null },
);
const statusArb = fc.constantFrom("approved", "applied", "dismissed");

const skillArb: fc.Arbitrary<RetiredSkillRow> = fc.record({
	name: titleArb,
	retired_reason: reasonArb,
});

const advisoryArb: fc.Arbitrary<ResolvedAdvisoryRow> = fc.record({
	title: titleArb,
	status: statusArb,
});

describe("renderNotifications — property tests", () => {
	it("F1: determinism — same inputs produce byte-equal output", () => {
		fc.assert(
			fc.property(
				fc.array(skillArb, { maxLength: 8 }),
				fc.array(advisoryArb, { maxLength: 16 }),
				(retiredSkills, resolvedAdvisories) => {
					const a = renderNotifications({ retiredSkills, resolvedAdvisories }).join("\n");
					const b = renderNotifications({ retiredSkills, resolvedAdvisories }).join("\n");
					return a === b;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("F2: cap — never emits more than ADVISORY_NOTIF_CAP advisory lines", () => {
		fc.assert(
			fc.property(fc.array(advisoryArb, { maxLength: 30 }), (resolvedAdvisories) => {
				const out = renderNotifications({ retiredSkills: [], resolvedAdvisories });
				const advLines = out.filter((l) => l.startsWith("[Advisory notification]"));
				return advLines.length <= ADVISORY_NOTIF_CAP;
			}),
			{ numRuns: 100 },
		);
	});

	it("F3: dedup — N copies of same (title,status) collapse to one line with (×N)", () => {
		fc.assert(
			fc.property(titleArb, statusArb, fc.integer({ min: 2, max: 10 }), (title, status, count) => {
				const advisories = Array.from({ length: count }, () => ({ title, status }));
				const out = renderNotifications({ retiredSkills: [], resolvedAdvisories: advisories });
				if (out.length !== 1) throw new Error(`expected 1 line, got ${out.length}`);
				if (!out[0].includes(`(×${count})`)) {
					throw new Error(`expected count marker (×${count}) in: ${out[0]}`);
				}
				return true;
			}),
			{ numRuns: 50 },
		);
	});

	it("F3b: single advisory has no count marker", () => {
		fc.assert(
			fc.property(advisoryArb, (advisory) => {
				const out = renderNotifications({
					retiredSkills: [],
					resolvedAdvisories: [advisory],
				});
				if (out.length !== 1) return false;
				return !out[0].includes("(×");
			}),
			{ numRuns: 50 },
		);
	});

	it("F4: empty inputs → empty output", () => {
		const out = renderNotifications({ retiredSkills: [], resolvedAdvisories: [] });
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
					const out = renderNotifications({ retiredSkills, resolvedAdvisories: [] });
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
					const out = renderNotifications({ retiredSkills, resolvedAdvisories });
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
					const out = renderNotifications({ retiredSkills, resolvedAdvisories });
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
			(_, i) => ({ title: `unique-${i}`, status: "applied" }),
		);
		const out = renderNotifications({ retiredSkills: [], resolvedAdvisories: advisories });
		if (out.length !== ADVISORY_NOTIF_CAP) {
			throw new Error(`expected ${ADVISORY_NOTIF_CAP} lines, got ${out.length}`);
		}
	});
});
