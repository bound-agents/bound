import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import {
	SAMPLE_SIZE,
	SAMPLE_WINDOW_DAYS,
	buildTokenFrequencyTable,
	checkR_VC9,
	checkR_VC9b,
} from "./r-vc9-compliance";

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
	const cutoff = new Date(nowMs - SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const samples = db
		.prepare(
			`SELECT key, value, tier
             FROM semantic_memory
             WHERE deleted IS NOT 1
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
			// Emit _validation:r-vc9-non-compliance:<key> outcome entry.
			const outcomeKey = `_validation:r-vc9-non-compliance:${s.key}`;
			const outcomeBody = JSON.stringify({
				key: s.key,
				slugTokens: r9.slugTokens,
				inBody: r9.inBody,
				aboveFreq: r9.aboveFreq,
				bothConditions: r9.bothConditions,
				checkedAt: new Date(nowMs).toISOString(),
			});
			const outcomeId = deterministicUUID(BOUND_NAMESPACE, outcomeKey);
			insertRow(
				db,
				"semantic_memory",
				{
					id: outcomeId,
					key: outcomeKey,
					value: outcomeBody,
					tier: "default",
					source: "validation:r-vc9",
					modified_at: new Date(nowMs).toISOString(),
					last_accessed_at: new Date(nowMs).toISOString(),
					created_at: new Date(nowMs).toISOString(),
					deleted: 0,
				},
				siteId,
			);
		}
		if (s.tier === "summary" && s.key.startsWith("_summary:")) {
			const r9b = checkR_VC9b(db, s.key, s.value);
			if (!r9b.pass) {
				rVc9bNonCompliant++;
				// Emit _validation:r-vc9b-non-compliance:<key>
				const outcomeKey = `_validation:r-vc9b-non-compliance:${s.key}`;
				const outcomeBody = JSON.stringify({
					key: s.key,
					childCount: r9b.childCount,
					childrenWithSubjectInGloss: r9b.childrenWithSubjectInGloss,
					failingChildKeys: r9b.failingChildKeys,
					checkedAt: new Date(nowMs).toISOString(),
				});
				const outcomeId = deterministicUUID(BOUND_NAMESPACE, outcomeKey);
				insertRow(
					db,
					"semantic_memory",
					{
						id: outcomeId,
						key: outcomeKey,
						value: outcomeBody,
						tier: "default",
						source: "validation:r-vc9b",
						modified_at: new Date(nowMs).toISOString(),
						last_accessed_at: new Date(nowMs).toISOString(),
						created_at: new Date(nowMs).toISOString(),
						deleted: 0,
					},
					siteId,
				);
			}
		}
	}

	// Update the last run timestamp for daily gating
	const lastRunKey = "_validation:r-vc9-last-run";
	const lastRunId = deterministicUUID(BOUND_NAMESPACE, lastRunKey);
	const lastRunValue = new Date(nowMs).toISOString();
	try {
		updateRow(
			db,
			"semantic_memory",
			lastRunId,
			{ modified_at: lastRunValue, value: lastRunValue },
			siteId,
		);
	} catch (_e) {
		// If update fails (doesn't exist), insert
		try {
			insertRow(
				db,
				"semantic_memory",
				{
					id: lastRunId,
					key: lastRunKey,
					value: lastRunValue,
					tier: "default",
					source: "validation:r-vc9",
					modified_at: lastRunValue,
					last_accessed_at: lastRunValue,
					created_at: lastRunValue,
					deleted: 0,
				},
				siteId,
			);
		} catch (_insertErr) {
			// Silently ignore — last-run tracking is advisory
			// and doesn't break the validation pass
		}
	}

	return {
		sampledKeys: samples.length,
		rVc9NonCompliantCount: rVc9NonCompliant,
		rVc9bNonCompliantCount: rVc9bNonCompliant,
	};
}

/**
 * Checks if the R-VC9 validation should run based on last-run timestamp.
 * Returns true if more than 24 hours have elapsed since the last run.
 */
export function shouldRunR_VC9Validation(db: Database, nowMs: number): boolean {
	const lastRunKey = "_validation:r-vc9-last-run";
	const row = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted IS NOT 1")
		.get(lastRunKey) as { value: string } | null;

	if (!row) return true; // Never run, so should run now

	try {
		const lastRunTime = new Date(row.value).getTime();
		const elapsed = nowMs - lastRunTime;
		return elapsed >= 24 * 60 * 60 * 1000; // 24 hours
	} catch (_e) {
		// Malformed timestamp, should run
		return true;
	}
}
