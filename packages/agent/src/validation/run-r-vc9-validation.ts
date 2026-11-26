import type { Database } from "bun:sqlite";
import {
	SAMPLE_SIZE,
	SAMPLE_WINDOW_DAYS,
	buildTokenFrequencyTable,
	checkR_VC9,
	checkR_VC9b,
} from "./r-vc9-compliance";
import { isValidationDue, recordValidationRun, writeValidationEntry } from "./validation-entries";

const R_VC9_LAST_RUN_KEY = "_validation:r-vc9-last-run";

export interface Vc9ValidationReport {
	sampledKeys: number;
	rVc9NonCompliantCount: number;
	rVc9bNonCompliantCount: number;
}

/**
 * Runs the §8.4 R-VC9/R-VC9b validation pass over a sample of recent memory entries.
 * Emits _validation:r-vc9-non-compliance:* and _validation:r-vc9b-non-compliance:* outcome entries
 * for non-compliant keys.
 *
 * MUST NOT throw on non-compliance — the validation is advisory only.
 */
export function runR_VC9Validation(
	db: Database,
	siteId: string,
	nowMs: number,
): Vc9ValidationReport {
	// Record the run BEFORE sampling so an empty corpus still records a pass.
	recordValidationRun(db, siteId, R_VC9_LAST_RUN_KEY, "validation:r-vc9", nowMs);

	const cutoff = new Date(nowMs - SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const samples = db
		.prepare(
			`SELECT key, value, tier
             FROM semantic_memory
             WHERE deleted = 0
               AND tier IN ('summary', 'detail')
               AND modified_at >= ?
             ORDER BY RANDOM()
             LIMIT ?`,
		)
		.all(cutoff, SAMPLE_SIZE) as Array<{ key: string; value: string; tier: string }>;

	if (samples.length === 0) {
		return { sampledKeys: 0, rVc9NonCompliantCount: 0, rVc9bNonCompliantCount: 0 };
	}

	const freq = buildTokenFrequencyTable(db);
	let rVc9NonCompliant = 0;
	let rVc9bNonCompliant = 0;

	for (const s of samples) {
		const r9 = checkR_VC9(s.key, s.value, freq);
		if (!r9.pass) {
			rVc9NonCompliant++;
			const outcomeKey = `_validation:r-vc9-non-compliance:${s.key}`;
			const outcomeBody = JSON.stringify({
				key: s.key,
				slugTokens: r9.slugTokens,
				inBody: r9.inBody,
				aboveFreq: r9.aboveFreq,
				bothConditions: r9.bothConditions,
				checkedAt: new Date(nowMs).toISOString(),
			});
			writeValidationEntry(db, siteId, {
				key: outcomeKey,
				value: outcomeBody,
				source: "validation:r-vc9",
				nowMs,
			});
		}
		if (s.tier === "summary" && s.key.startsWith("_summary:")) {
			const r9b = checkR_VC9b(db, s.key, s.value);
			if (!r9b.pass) {
				rVc9bNonCompliant++;
				const outcomeKey = `_validation:r-vc9b-non-compliance:${s.key}`;
				const outcomeBody = JSON.stringify({
					key: s.key,
					childCount: r9b.childCount,
					childrenWithSubjectInGloss: r9b.childrenWithSubjectInGloss,
					failingChildKeys: r9b.failingChildKeys,
					checkedAt: new Date(nowMs).toISOString(),
				});
				writeValidationEntry(db, siteId, {
					key: outcomeKey,
					value: outcomeBody,
					source: "validation:r-vc9b",
					nowMs,
				});
			}
		}
	}

	return {
		sampledKeys: samples.length,
		rVc9NonCompliantCount: rVc9NonCompliant,
		rVc9bNonCompliantCount: rVc9bNonCompliant,
	};
}

/** True when more than 24 hours have elapsed since the last R-VC9 run. */
export function shouldRunR_VC9Validation(db: Database, nowMs: number): boolean {
	return isValidationDue(db, R_VC9_LAST_RUN_KEY, nowMs, 24 * 60 * 60 * 1000);
}
