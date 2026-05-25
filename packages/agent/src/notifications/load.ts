/**
 * DB-loading wrapper for operator-feedback notifications.
 *
 * The pure renderer lives in `render.ts`. This module is the only
 * place that issues SQL or reads wall-clock time; pulling it out of
 * `context-assembly.ts` keeps the volatile-context builder declarative
 * (`load → render → push`) and isolates the 24-h cutoff math.
 */

import type Database from "bun:sqlite";
import type { ResolvedAdvisoryRow, RetiredSkillRow } from "./render";

export interface LoadNotificationInputsParams {
	db: Database;
	/** Site identity. When `null` / `undefined`, advisory rows are not loaded. */
	siteId: string | null | undefined;
	/** Wall-clock anchor for the 24-h cutoff. Defaults to `Date.now()`. */
	nowMs?: number;
}

export interface NotificationInputs {
	retiredSkills: RetiredSkillRow[];
	resolvedAdvisories: ResolvedAdvisoryRow[];
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Reads operator-action rows resolved within the last 24 h. Failures
 * are non-fatal — a query error degrades to an empty list rather than
 * blocking the volatile-tail emission, matching the prior inline
 * try/catch behavior.
 */
export function loadNotificationInputs(params: LoadNotificationInputsParams): NotificationInputs {
	const nowMs = params.nowMs ?? Date.now();
	const cutoff24h = new Date(nowMs - TWENTY_FOUR_HOURS_MS).toISOString();

	let retiredSkills: RetiredSkillRow[] = [];
	try {
		retiredSkills = params.db
			.query(
				`SELECT name, retired_reason FROM skills
				 WHERE status = 'retired'
				   AND retired_by = 'operator'
				   AND modified_at > ?
				   AND deleted = 0`,
			)
			.all(cutoff24h) as RetiredSkillRow[];
	} catch (_error) {
		// Non-fatal: retired skills query failed.
	}

	let resolvedAdvisories: ResolvedAdvisoryRow[] = [];
	if (params.siteId) {
		try {
			resolvedAdvisories = params.db
				.query(
					`SELECT title, status FROM advisories
					 WHERE created_by = ?
					   AND status IN ('approved', 'applied', 'dismissed')
					   AND resolved_at > ?
					   AND deleted = 0
					 ORDER BY resolved_at DESC`,
				)
				.all(params.siteId, cutoff24h) as ResolvedAdvisoryRow[];
		} catch (_error) {
			// Non-fatal: resolved advisories query failed.
		}
	}

	return { retiredSkills, resolvedAdvisories };
}
