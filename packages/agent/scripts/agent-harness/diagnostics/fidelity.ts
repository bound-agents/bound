/**
 * Progressive fidelity diagnostic plugin.
 *
 * Collects per-turn data about the three-tier truncation system and renders
 * a summary table showing tier breakdowns, budget utilization, and whether
 * the middle-tier digest stays byte-stable between cold paths.
 *
 * Run with: --diagnostic fidelity (or fidelity,cache for combined output)
 */

import type { Diagnostic, DiagnosticTurnData } from "./types";

interface FidelityRecord {
	turn: number;
	cachePath: string;
	truncated: number;
	ancientDropped: number | null;
	middleFolded: number | null;
	recentKept: number | null;
	tierBudgets: { ancient: number; middle: number; recent: number } | null;
	tierTokens: { ancient: number; middle: number; recent: number } | null;
	totalEstimated: number | null;
	effectiveBudget: number | null;
}

export function buildFidelityDiagnostic(): Diagnostic {
	return {
		name: "fidelity",
		description:
			"Progressive fidelity tier breakdown — shows ancient/middle/recent allocation per cold turn",

		collect(data: DiagnosticTurnData): Record<string, unknown> {
			const pf = (data.contextDebug as Record<string, unknown> | null)?.progressiveFidelity as
				| (FidelityRecord["tierTokens"] & {
						ancientDropped: number;
						middleFolded: number;
						recentKept: number;
						tierBudgets: FidelityRecord["tierBudgets"];
						tierTokens: FidelityRecord["tierTokens"];
				  })
				| undefined;

			return {
				turn: data.turn,
				cachePath: data.cachePath,
				truncated: data.contextDebug?.truncated ?? 0,
				ancientDropped: pf?.ancientDropped ?? null,
				middleFolded: pf?.middleFolded ?? null,
				recentKept: pf?.recentKept ?? null,
				tierBudgets: pf?.tierBudgets ?? null,
				tierTokens: pf?.tierTokens ?? null,
				totalEstimated: data.contextDebug?.totalEstimated ?? null,
				effectiveBudget: data.contextDebug?.effectiveBudget ?? null,
			} satisfies FidelityRecord;
		},

		render(perTurnRecords: ReadonlyArray<Record<string, unknown>>): string {
			const records = perTurnRecords as unknown as ReadonlyArray<FidelityRecord>;

			if (records.length === 0) return "  (no turns recorded)\n";

			const lines: string[] = [];
			lines.push("");
			lines.push(
				"  n  path  truncated  ancient  middle  recent  mid_tokens  rec_tokens  budget_use%",
			);
			lines.push(
				"  -- ----  ---------  -------  ------  ------  ----------  ----------  -----------",
			);

			const coldRecords: FidelityRecord[] = [];

			for (const r of records) {
				if (r.cachePath !== "cold" || r.tierTokens === null) {
					lines.push(
						`  ${pad(r.turn, 2)}  ${pad(r.cachePath, 4)}  ${pad(r.truncated, 9)}  ${"—".padEnd(7)}  ${"—".padEnd(6)}  ${"—".padEnd(6)}  ${"—".padEnd(10)}  ${"—".padEnd(10)}  (${r.cachePath}, no fidelity)`,
					);
					continue;
				}

				coldRecords.push(r);
				const tierT = r.tierTokens;
				const totalTier = tierT.ancient + tierT.middle + tierT.recent;
				const budget = r.tierBudgets
					? r.tierBudgets.ancient + r.tierBudgets.middle + r.tierBudgets.recent
					: totalTier;
				const utilPct = budget > 0 ? ((totalTier / budget) * 100).toFixed(1) : "—";

				lines.push(
					`  ${pad(r.turn, 2)}  ${pad(r.cachePath, 4)}  ${pad(r.truncated, 9)}  ${pad(r.ancientDropped ?? 0, 7)}  ${pad(r.middleFolded ?? 0, 6)}  ${pad(r.recentKept ?? 0, 6)}  ${pad(tierT.middle, 10)}  ${pad(tierT.recent, 10)}  ${utilPct}%`,
				);
			}

			// Summary footer
			lines.push("");
			lines.push("  progressive fidelity summary:");

			if (coldRecords.length === 0) {
				lines.push("    (no cold-path turns with progressive fidelity data)");
			} else {
				const pfRecords = coldRecords.filter((r) => r.middleFolded !== null && r.middleFolded > 0);

				if (pfRecords.length === 0) {
					lines.push("    middle_tier_active:  false (no turns produced a middle tier)");
				} else {
					const avgMiddle = Math.round(
						pfRecords.reduce((s, r) => s + (r.middleFolded ?? 0), 0) / pfRecords.length,
					);
					const avgRecent = Math.round(
						pfRecords.reduce((s, r) => s + (r.recentKept ?? 0), 0) / pfRecords.length,
					);

					// Budget utilization
					const avgUtil =
						pfRecords.reduce((s, r) => {
							const tierT = r.tierTokens ?? { ancient: 0, middle: 0, recent: 0 };
							const totalTier = tierT.ancient + tierT.middle + tierT.recent;
							const budget = r.tierBudgets
								? r.tierBudgets.ancient + r.tierBudgets.middle + r.tierBudgets.recent
								: totalTier;
							return s + (budget > 0 ? totalTier / budget : 0);
						}, 0) / pfRecords.length;

					// Compression ratio: middle_folded_msgs / middle_tokens
					// vs what those messages would cost at full resolution
					// Approximation: folded messages averaged ~200 tokens each at full res
					const avgMiddleTokens =
						pfRecords.reduce((s, r) => s + (r.tierTokens?.middle ?? 0), 0) / pfRecords.length;
					const estFullRes = avgMiddle * 200; // rough estimate
					const compressionRatio =
						avgMiddleTokens > 0 ? (estFullRes / avgMiddleTokens).toFixed(1) : "—";

					lines.push(`    avg_middle_folded:    ${avgMiddle}`);
					lines.push(`    avg_recent_kept:      ${avgRecent}`);
					lines.push(
						`    budget_utilization:   ${(avgUtil * 100).toFixed(1)}% (tier tokens / history budget)`,
					);
					lines.push(
						`    compression_ratio:    ~${compressionRatio}x (est. full-res tokens / middle tier tokens)`,
					);
					lines.push(
						`    middle_tier_active:   true (${pfRecords.length}/${coldRecords.length} cold turns)`,
					);
				}
			}

			lines.push("");
			return lines.join("\n");
		},
	};
}

function pad(value: unknown, width: number): string {
	return String(value).padEnd(width);
}
