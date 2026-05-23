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
	// Update the last run timestamp BEFORE sampling (so even empty corpus records a run)
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
		} catch (insertErr) {
			// Advisory only — log and continue
			console.warn("[r-vc9-validation] last-run entry write failed:", insertErr);
		}
	}

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
			const now = new Date(nowMs).toISOString();

			// Try update first (idempotent pattern), fall back to insert if needed
			try {
				updateRow(
					db,
					"semantic_memory",
					outcomeId,
					{
						value: outcomeBody,
						modified_at: now,
						last_accessed_at: now,
					},
					siteId,
				);
			} catch (_updateErr) {
				// Insert if update fails (row doesn't exist)
				try {
					insertRow(
						db,
						"semantic_memory",
						{
							id: outcomeId,
							key: outcomeKey,
							value: outcomeBody,
							tier: "default",
							source: "validation:r-vc9",
							modified_at: now,
							last_accessed_at: now,
							created_at: now,
							deleted: 0,
						},
						siteId,
					);
				} catch (insertErr) {
					// Advisory only — log and continue
					console.warn("[r-vc9-validation] R-VC9 outcome entry write failed:", insertErr);
				}
			}
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
				const now = new Date(nowMs).toISOString();

				// Try update first (idempotent pattern), fall back to insert if needed
				try {
					updateRow(
						db,
						"semantic_memory",
						outcomeId,
						{
							value: outcomeBody,
							modified_at: now,
							last_accessed_at: now,
						},
						siteId,
					);
				} catch (_updateErr) {
					// Insert if update fails (row doesn't exist)
					try {
						insertRow(
							db,
							"semantic_memory",
							{
								id: outcomeId,
								key: outcomeKey,
								value: outcomeBody,
								tier: "default",
								source: "validation:r-vc9b",
								modified_at: now,
								last_accessed_at: now,
								created_at: now,
								deleted: 0,
							},
							siteId,
						);
					} catch (insertErr) {
						// Advisory only — log and continue
						console.warn("[r-vc9-validation] R-VC9b outcome entry write failed:", insertErr);
					}
				}
			}
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
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
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
