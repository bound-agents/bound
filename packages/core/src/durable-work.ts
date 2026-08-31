import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { TypedEventEmitter } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import { withCoreSpan } from "./telemetry";

let durableWorkEventBus: TypedEventEmitter | null = null;

/**
 * Set the event bus for `durable_work:written` events. Called at startup to
 * enable push-on-insert spool transfer for peer-targeted rows (R-DW10/R-DW11),
 * mirroring {@link setRelayOutboxEventBus}.
 */
export function setDurableWorkEventBus(eventBus: TypedEventEmitter | null): void {
	durableWorkEventBus = eventBus;
}

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
	stream_id: string | null;
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
	stream_id?: string | null;
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
			(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, ref_id, source_site, received_at, stream_id)
			VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`,
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
				row.stream_id ?? null,
			],
		);
		const inserted = result.changes === 1;
		// Emit only when a NEW row was inserted (never on the INSERT-OR-IGNORE
		// fence dedupe), mirroring writeOutbox's cycle-breaker: a duplicate emit
		// would re-drive an already-transferred row. The transport listener filters
		// to peer-targeted rows and capability-gates them, so emitting for
		// local-targeted rows is harmless (no matching peer drain).
		//
		// Events-after-commit (invariant #6): a standalone insert has already
		// committed via the implicit single-statement transaction by the time we
		// reach here, so it is safe to emit. But when this insert runs INSIDE a
		// larger transaction (db.inTransaction), the enclosing write has NOT
		// committed yet and may still ROLL BACK — a spool-drain listener firing now
		// could transition/send a row whose transaction later aborts. So we SKIP
		// the emit and let the caller flush it post-commit via
		// emitDurableWorkWritten(). The `inserted` return lets the caller collect
		// exactly the ids that actually became durable, so a deferred emit never
		// fires for a dedupe or a rolled-back insert.
		if (inserted && !db.inTransaction && durableWorkEventBus) {
			durableWorkEventBus.emit("durable_work:written", {
				id: row.id,
				target_site_id: row.target_site_id,
			});
		}
		return inserted;
	});
}

/**
 * Post-commit emission of `durable_work:written` for rows inserted inside a
 * transaction, where {@link insertDurableWork} deliberately suppressed the
 * automatic emit (invariant #6 — events fire after COMMIT, never mid-
 * transaction). An in-transaction producer collects the ids that actually
 * became durable (insertDurableWork returned true) and calls this once the
 * enclosing transaction has returned/committed. Emitting only for genuinely-
 * inserted rows preserves the writeOutbox cycle-breaker: no re-drive of a
 * deduped row, and nothing at all for a transaction that rolled back (the
 * caller never collected those ids). Standalone inserts must NOT route through
 * this — they already emitted inline.
 */
export function emitDurableWorkWritten(
	rows: ReadonlyArray<{ id: string; target_site_id: string }>,
): void {
	if (!durableWorkEventBus || rows.length === 0) return;
	for (const row of rows) {
		durableWorkEventBus.emit("durable_work:written", {
			id: row.id,
			target_site_id: row.target_site_id,
		});
	}
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

/**
 * Token-fenced terminal transition for a claimed generation. Unlike
 * {@link deadLetterDurableWork} (which updates by id alone), this requires the
 * row to still be `processing` under the exact `claimToken` the caller minted,
 * so a stale claimant that lost the row to boot recovery + reclaim cannot
 * dead-letter a newer generation. Used by the relay consumer lane's terminal
 * transitions.
 */
export function deadLetterClaimedDurableWork(
	db: Database,
	id: string,
	claimToken: string,
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
		 last_error = ?, dead_lettered_at = ?, expires_at = ?
		 WHERE id = ? AND claim_state = 'processing' AND claim_token = ?`,
				[error, now, retention, id, claimToken],
			).changes === 1,
	);
}

/**
 * Fence a *pending* row into a dead letter — the disposition the intake
 * reconciler needs for orphaned passive intake, where no claim generation
 * exists. Requiring `claim_state = 'pending'` keeps a concurrent claim from
 * being clobbered mid-flight while preserving the reconciler's semantics.
 */
export function deadLetterPendingDurableWork(
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
		 last_error = ?, dead_lettered_at = ?, expires_at = ?
		 WHERE id = ? AND claim_state = 'pending'`,
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

/**
 * Peer-targeted pending rows the local host must drain over the spool. Excludes
 * the owning host's own local-consumer rows (those are claimed in-process, never
 * transferred). Ordered oldest-first for a stable reconnect drain, mirroring
 * {@link readUndelivered} for the relay outbox.
 */
export function readPendingPeerTargetedDurableWork(
	db: Database,
	ownSiteId: string,
	targetSiteId?: string,
): DurableWorkRow[] {
	if (targetSiteId) {
		return db
			.query(
				`SELECT * FROM durable_work WHERE claim_state = 'pending' AND target_site_id = ? AND target_site_id != ? ORDER BY created_at`,
			)
			.all(targetSiteId, ownSiteId) as DurableWorkRow[];
	}
	return db
		.query(
			`SELECT * FROM durable_work WHERE claim_state = 'pending' AND target_site_id != ? ORDER BY created_at`,
		)
		.all(ownSiteId) as DurableWorkRow[];
}

/**
 * Rows this host began transferring but has not yet had acknowledged. On
 * reconnect (or boot), these re-send to the target: the receiver's
 * `(kind, idempotency_key)` fence makes a redelivered transfer idempotent, so
 * resuming an in-flight transfer with the retained token is safe. Ordered
 * oldest-first. Boot recovery ({@link resetProcessingDurableWork}) touches only
 * `processing`, never `transferring`, so a crashed sender keeps its transfer
 * identity and resumes rather than double-inserting a fresh pending row.
 */
export function readTransferringDurableWork(db: Database, targetSiteId?: string): DurableWorkRow[] {
	if (targetSiteId) {
		return db
			.query(
				`SELECT * FROM durable_work WHERE claim_state = 'transferring' AND target_site_id = ? ORDER BY created_at`,
			)
			.all(targetSiteId) as DurableWorkRow[];
	}
	return db
		.query(`SELECT * FROM durable_work WHERE claim_state = 'transferring' ORDER BY created_at`)
		.all() as DurableWorkRow[];
}
