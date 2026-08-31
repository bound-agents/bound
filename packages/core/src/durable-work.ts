import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { withCoreSpan } from "./telemetry";

/** Set BOUND_DURABLE_INTAKE=0 or false before startup to restore legacy relay-inbox intake writes. */
export let DURABLE_INTAKE_ENABLED = !["0", "false"].includes(
	process.env.BOUND_DURABLE_INTAKE?.toLowerCase() ?? "",
);

/** Test seam for exercising the intake rollback route without changing production defaults. */
export function setDurableIntakeEnabledForTesting(enabled: boolean): void {
	DURABLE_INTAKE_ENABLED = enabled;
}

export type DurableWorkClaimState =
	| "pending"
	| "processing"
	| "transferring"
	| "consumed"
	| "dead_letter";
export type WorkClaimDiscipline = "local-exclusive" | "optimistic-lease" | "none";
export type WorkRetirementRule = "single-ack" | "all-subscriber-cursors-past";

export interface DurableWorkRow {
	id: string;
	target_site_id: string;
	kind: string;
	payload: string;
	idempotency_key: string;
	claim_state: DurableWorkClaimState;
	claim_token: string | null;
	claimed_at: string | null;
	attempt_count: number;
	last_error: string | null;
	created_at: string;
	expires_at: string | null;
	dead_lettered_at: string | null;
	consumed_at: string | null;
	ref_id: string | null;
	source_site: string | null;
	received_at: string | null;
}

export interface NewDurableWork {
	id: string;
	target_site_id: string;
	kind: string;
	payload: string;
	idempotency_key: string;
	expires_at?: string | null;
	ref_id?: string | null;
	source_site?: string | null;
	received_at?: string | null;
}

export class InvalidDurableWorkRowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidDurableWorkRowError";
	}
}

export function validateDurableWork(row: NewDurableWork): void {
	if (!row.id || !row.target_site_id || !row.kind || !row.idempotency_key) {
		throw new InvalidDurableWorkRowError(
			"durable work requires id, target_site_id, kind, and idempotency_key",
		);
	}
	if (!row.payload)
		throw new InvalidDurableWorkRowError("durable work payload must be a non-empty JSON string");
	try {
		JSON.parse(row.payload);
	} catch {
		throw new InvalidDurableWorkRowError("durable work payload must be valid JSON");
	}
}

function instrument<T>(operation: string, kind: string, fn: () => T): T {
	return withCoreSpan(
		"durable_work.operation",
		{
			"durable_work.operation": operation,
			"durable_work.kind": kind,
			"durable_work.persistence": "local",
		},
		(span) => {
			try {
				const result = fn();
				span.setAttribute?.("durable_work.outcome", "ok");
				return result;
			} catch (error) {
				span.setAttribute?.("durable_work.outcome", "failed");
				trace.getActiveSpan()?.recordException(error as Error);
				throw error;
			}
		},
	);
}

/** Insert the receiver copy / local row. False means the kind/key fence already exists. */
export function insertDurableWork(db: Database, row: NewDurableWork): boolean {
	validateDurableWork(row);
	return instrument("insert", row.kind, () => {
		const now = new Date().toISOString();
		const result = db.run(
			`INSERT OR IGNORE INTO durable_work
			(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, ref_id, source_site, received_at)
			VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.target_site_id,
				row.kind,
				row.payload,
				row.idempotency_key,
				now,
				row.expires_at ?? null,
				row.ref_id ?? null,
				row.source_site ?? null,
				row.received_at ?? null,
			],
		);
		return result.changes === 1;
	});
}

/** BEGIN IMMEDIATE makes local-exclusive selection and ownership one SQLite operation. */
export function claimLocalDurableWork(
	db: Database,
	targetSiteId: string,
	kind?: string,
): DurableWorkRow | null {
	return instrument("claim", kind ?? "any", () => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = (
				kind
					? db
							.query(
								`SELECT * FROM durable_work WHERE target_site_id = ? AND kind = ? AND claim_state = 'pending' ORDER BY created_at LIMIT 1`,
							)
							.get(targetSiteId, kind)
					: db
							.query(
								`SELECT * FROM durable_work WHERE target_site_id = ? AND claim_state = 'pending' ORDER BY created_at LIMIT 1`,
							)
							.get(targetSiteId)
			) as DurableWorkRow | null;
			if (!row) {
				db.exec("COMMIT");
				return null;
			}
			const token = randomUUID();
			const now = new Date().toISOString();
			db.run(
				`UPDATE durable_work SET claim_state = 'processing', claim_token = ?, claimed_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND claim_state = 'pending'`,
				[token, now, row.id],
			);
			db.exec("COMMIT");
			return {
				...row,
				claim_state: "processing",
				claim_token: token,
				claimed_at: now,
				attempt_count: row.attempt_count + 1,
			};
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* original error wins */
			}
			throw error;
		}
	});
}

/**
 * Claim a specific set of pending rows by id under one BEGIN IMMEDIATE, minting
 * a fresh per-row token so each claimed generation is independently fenced —
 * the same ownership discipline as {@link claimLocalDurableWork}, but for a
 * caller that has already selected which rows to take (the scheduler's
 * event-wakeup fold, which claims exactly the durable intake rows it folds).
 * Ids that are missing or no longer pending are silently skipped; only rows
 * still `pending` transition to `processing` and appear in the result.
 */
export function claimDurableWorkByIds(
	db: Database,
	ids: readonly string[],
	targetSiteId: string,
): DurableWorkRow[] {
	if (ids.length === 0) return [];
	return instrument("claim-by-ids", "any", () => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const placeholders = ids.map(() => "?").join(", ");
			const pending = db
				.query(
					`SELECT * FROM durable_work WHERE target_site_id = ? AND claim_state = 'pending' AND id IN (${placeholders})`,
				)
				.all(targetSiteId, ...ids) as DurableWorkRow[];
			const now = new Date().toISOString();
			const claimed: DurableWorkRow[] = [];
			for (const row of pending) {
				const token = randomUUID();
				db.run(
					`UPDATE durable_work SET claim_state = 'processing', claim_token = ?, claimed_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND claim_state = 'pending'`,
					[token, now, row.id],
				);
				claimed.push({
					...row,
					claim_state: "processing",
					claim_token: token,
					claimed_at: now,
					attempt_count: row.attempt_count + 1,
				});
			}
			db.exec("COMMIT");
			return claimed;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* original error wins */
			}
			throw error;
		}
	});
}

/** A consumer may retire only its active claim generation. */
export function acknowledgeDurableWork(db: Database, id: string, claimToken: string): boolean {
	return instrument(
		"consume-ack",
		"unknown",
		() =>
			db.run(
				"UPDATE durable_work SET claim_state = 'consumed', consumed_at = ?, claim_token = NULL, claimed_at = NULL WHERE id = ? AND claim_state = 'processing' AND claim_token = ?",
				[new Date().toISOString(), id, claimToken],
			).changes === 1,
	);
}

/** Sender-side handoff begins before network transfer; it remains durable until receiver acknowledgement. */
export function beginDurableWorkTransfer(db: Database, id: string): string | null {
	return instrument("transfer-begin", "unknown", () => {
		const token = randomUUID();
		const result = db.run(
			`UPDATE durable_work SET claim_state = 'transferring', claim_token = ?, claimed_at = ? WHERE id = ? AND claim_state = 'pending'`,
			[token, new Date().toISOString(), id],
		);
		return result.changes === 1 ? token : null;
	});
}

/** Transfer acknowledgement retires only the sender copy; receiver consumption is separate. */
export function acknowledgeDurableWorkTransfer(
	db: Database,
	id: string,
	transferToken: string,
): boolean {
	return instrument(
		"transfer-ack",
		"unknown",
		() =>
			db.run(
				"DELETE FROM durable_work WHERE id = ? AND claim_state = 'transferring' AND claim_token = ?",
				[id, transferToken],
			).changes === 1,
	);
}

/** Boot recovery releases only abandoned local processing generations. */
export function resetProcessingDurableWork(db: Database, targetSiteId: string): number {
	return instrument(
		"restart-recovery",
		"any",
		() =>
			db.run(
				"UPDATE durable_work SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL WHERE target_site_id = ? AND claim_state = 'processing'",
				[targetSiteId],
			).changes,
	);
}

/** Expiry and terminal failure are preserved as seven-day dead-letter rows, never silently discarded. */
export function deadLetterExpiredDurableWork(db: Database, now = new Date().toISOString()): number {
	const retention = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
	return instrument(
		"expiry",
		"any",
		() =>
			db.run(
				`UPDATE durable_work SET claim_state = 'dead_letter', claim_token = NULL, claimed_at = NULL,
		 last_error = COALESCE(last_error, 'expired'), dead_lettered_at = ?, expires_at = ?
		 WHERE claim_state != 'dead_letter' AND expires_at IS NOT NULL AND expires_at <= ?`,
				[now, retention, now],
			).changes,
	);
}

export function deadLetterDurableWork(
	db: Database,
	id: string,
	error: string,
	now = new Date().toISOString(),
): boolean {
	const retention = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
	return instrument(
		"dead-letter",
		"unknown",
		() =>
			db.run(
				`UPDATE durable_work SET claim_state = 'dead_letter', claim_token = NULL, claimed_at = NULL,
		 last_error = ?, dead_lettered_at = ?, expires_at = ? WHERE id = ? AND claim_state != 'dead_letter'`,
				[error, now, retention, id],
			).changes === 1,
	);
}

/** Retain consumed idempotency fences for the same one-hour window as legacy dispatch acknowledgements. */
export function pruneConsumedDurableWork(db: Database, cutoff: string): number {
	return instrument(
		"consumed-prune",
		"any",
		() =>
			db.run(
				"DELETE FROM durable_work WHERE claim_state = 'consumed' AND consumed_at IS NOT NULL AND consumed_at < ?",
				[cutoff],
			).changes,
	);
}

export function pruneExpiredDeadLetters(db: Database, now = new Date().toISOString()): number {
	return instrument(
		"dead-letter-prune",
		"any",
		() =>
			db.run(
				"DELETE FROM durable_work WHERE claim_state = 'dead_letter' AND expires_at IS NOT NULL AND expires_at <= ?",
				[now],
			).changes,
	);
}

export interface DurableWorkInspectionRow extends DurableWorkRow {
	age_ms: number;
}

/**
 * Reopen a dead letter without changing its delivery identity. The existing
 * `(kind, idempotency_key)` row remains the fence; a retired row is absent and
 * therefore cannot be resurrected by this operation.
 */
export function redriveDeadLetterDurableWork(
	db: Database,
	id: string,
	expiresAt: string | null,
): boolean {
	return instrument(
		"redrive",
		"unknown",
		() =>
			db.run(
				`UPDATE durable_work
			 SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL,
			     dead_lettered_at = NULL, expires_at = ?
			 WHERE id = ? AND claim_state = 'dead_letter'`,
				[expiresAt, id],
			).changes === 1,
	);
}
