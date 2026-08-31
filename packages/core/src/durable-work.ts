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

/** Set BOUND_DURABLE_RELAY=0 or false before startup to restore legacy relay_outbox writes for all active non-stream RPC. */
export let DURABLE_RELAY_ENABLED = !["0", "false"].includes(
	process.env.BOUND_DURABLE_RELAY?.toLowerCase() ?? "",
);

/** Test seam for exercising the relay rollback route without changing production defaults. */
export function setDurableRelayEnabledForTesting(enabled: boolean): void {
	DURABLE_RELAY_ENABLED = enabled;
}

/**
 * Sentinel `target_site_id` for rows consumed in-process by the owning host
 * (dispatch wakeups). It is NOT a peer site id: a row targeted `local` must
 * never enter the spool-transfer path — it has no meaning on any other host,
 * and shipping it away strands the wakeup it carries (the thread never wakes).
 * Every peer-transfer selector and the transport push listener exclude it.
 */
export const LOCAL_WORK_TARGET = "local";

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

/**
 * Release a consumer's active claim back to `pending` WITHOUT consuming the row,
 * for a *retryable* disposition — the firing was neither executed nor failed, so
 * it must remain claimable next tick rather than being retired to `consumed`
 * (whose `(kind, idempotency_key)` fence would block a re-enqueue of the same
 * key) or dead-lettered. Token-fenced: only the live claim generation may
 * release, so a stale token (a peer reclaimed, boot recovery already reset it)
 * is a no-op.
 *
 * Decrements `attempt_count` by one so the release is *attempt-neutral*: the
 * claim path ({@link claimLocalDurableWork} / {@link claimDurableWorkByIds})
 * increments `attempt_count` on every claim, and a retryable release means the
 * attempt did not consume budget (e.g. a daily-budget deferral that will re-run
 * once budget clears, or a crash-window firing waiting on peer eviction).
 * Without the decrement, repeated releases across ticks would march the row
 * toward the attempt-N dead-letter budget for reasons that are not failures.
 * `MAX(attempt_count - 1, 0)` guards against underflow.
 */
export function releaseDurableWorkClaim(db: Database, id: string, claimToken: string): boolean {
	return instrument(
		"release-claim",
		"unknown",
		() =>
			db.run(
				"UPDATE durable_work SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL, attempt_count = MAX(attempt_count - 1, 0) WHERE id = ? AND claim_state = 'processing' AND claim_token = ?",
				[id, claimToken],
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

/**
 * Boot recovery for rows a buggy spool push hijacked: a {@link LOCAL_WORK_TARGET}
 * row is consumed in-process only and can never legitimately be `transferring`
 * (peer transfer excludes the sentinel), so any such row is a stranded wakeup —
 * reset it to `pending` so the local consumer claims it. Distinct from
 * {@link resetProcessingDurableWork}: `transferring` is deliberately preserved
 * across boots for real peer-targeted rows (the sender resumes with its retained
 * token), which is exactly why hijacked local rows would otherwise stay wedged
 * forever.
 */
export function resetTransferringLocalDurableWork(db: Database): number {
	return instrument(
		"restart-recovery-local-transfer",
		"any",
		() =>
			db.run(
				"UPDATE durable_work SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL WHERE target_site_id = ? AND claim_state = 'transferring'",
				[LOCAL_WORK_TARGET],
			).changes,
	);
}

/**
 * Transfer/claim staleness window for the running-process transfer sweep. A
 * peer-targeted row that has been `transferring` (i.e. `claimed_at`) longer than
 * this has almost certainly lost its SPOOL_TRANSFER_ACK — a live ack round-trips
 * in the RPC-TTL class (~seconds), so 30s is generous headroom that never races
 * a slow-but-live ack. This is DISTINCT from `expires_at` (the work's terminal
 * semantic TTL, owned by {@link deadLetterExpiredDurableWork}): a dropped ack
 * must be retried while the work is still LIVE, long before its terminal
 * deadline, and the two clocks must not be conflated.
 */
export const DURABLE_WORK_TRANSFER_STALE_MS = 30_000;

/**
 * Attempt cap for durable work, enforced on BOTH sides. The relay consumer
 * applies it post-claim on the destination ({@link deadLetterClaimedDurableWork}
 * once `attempt_count >= this`); {@link sweepStaleTransferringDurableWork} and
 * {@link redriveTransferringDurableWork} apply it on the sender transfer path.
 * One source of truth so the two paths cannot drift; `DURABLE_RELAY_MAX_ATTEMPTS`
 * in the relay processor is defined as this value.
 */
export const DURABLE_WORK_MAX_ATTEMPTS = 3;

/**
 * Running-process recovery for a peer-targeted row stuck in `transferring` after
 * its transfer timeout lapsed: the SPOOL_TRANSFER shipped but no
 * SPOOL_TRANSFER_ACK ever retired the sender copy, and — unlike a crash — the
 * process never restarts to re-run boot recovery. `beginDurableWorkTransfer`
 * mints the transferring generation without charging an attempt, so the spool
 * only re-sends on a *reconnect* drain; a persistently-connected sender whose
 * ack was dropped has no other retry path (R-DW10: retire only on ack).
 *
 * STALENESS IS KEYED ON THE TRANSFER CLOCK, NOT THE TERMINAL TTL. A row is stale
 * when `claimed_at <= now - DURABLE_WORK_TRANSFER_STALE_MS`. `expires_at` keeps
 * its terminal meaning entirely: a row already past `expires_at` is NOT swept
 * here — it belongs to {@link deadLetterExpiredDurableWork}, which dead-letters
 * it rather than requeuing it. Excluding terminally-expired rows means the two
 * sweeps never race over the same row and a resend can never carry an expired
 * deadline.
 *
 * ATTEMPT CAP (sender-side). A row whose `attempt_count` is already at or over
 * the caller-supplied `maxAttempts` is dead-lettered with a transfer-exhaustion
 * `last_error` instead of being re-pended — the sender path enforces the cap the
 * runbook promises, mirroring the post-claim cap the relay consumer applies on
 * the destination. Otherwise the row returns to `pending` with `attempt_count`
 * incremented so a genuinely poisoned transfer marches toward that cap.
 *
 * The `claim_token` is cleared with the reset: a late ack for the retired
 * generation carries the old token and the (id, transferring, token) fence in
 * {@link acknowledgeDurableWorkTransfer} rejects it, so a re-sent-then-acked row
 * cannot be double-retired. Returns the number of rows touched (re-pended plus
 * dead-lettered).
 */
export function sweepStaleTransferringDurableWork(
	db: Database,
	maxAttempts: number,
	now = new Date().toISOString(),
): number {
	return instrument("sweep-stale-transferring", "any", () => {
		const staleBefore = new Date(Date.parse(now) - DURABLE_WORK_TRANSFER_STALE_MS).toISOString();
		const retention = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
		// Dead-letter the poisoned generations first (at/over cap), then re-pend the
		// rest. Both are gated identically: transferring, transfer timeout lapsed,
		// and NOT already past terminal expiry (that is the terminal sweep's row).
		const deadLettered = db.run(
			`UPDATE durable_work SET claim_state = 'dead_letter', claim_token = NULL, claimed_at = NULL,
		 last_error = 'transfer retries exhausted (no SPOOL_TRANSFER_ACK)', dead_lettered_at = ?, expires_at = ?
		 WHERE claim_state = 'transferring' AND claimed_at IS NOT NULL AND claimed_at <= ?
		   AND (expires_at IS NULL OR expires_at > ?)
		   AND attempt_count >= ?`,
			[now, retention, staleBefore, now, maxAttempts],
		).changes;
		const rePended = db.run(
			`UPDATE durable_work SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL,
		 attempt_count = attempt_count + 1
		 WHERE claim_state = 'transferring' AND claimed_at IS NOT NULL AND claimed_at <= ?
		   AND (expires_at IS NULL OR expires_at > ?)
		   AND attempt_count < ?`,
			[staleBefore, now, maxAttempts],
		).changes;
		return deadLettered + rePended;
	});
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

/**
 * Operator/agent manual recovery for one wedged transfer: reclaim a specific
 * `transferring` row. The by-id sibling of {@link sweepStaleTransferringDurableWork}
 * for the `workspool redrive` path, with no transfer-timeout guard — an operator
 * naming a row has already judged it stuck. It DOES respect the attempt cap: a
 * row already at or over `maxAttempts` dead-letters (transfer-exhaustion
 * `last_error`) rather than re-pending, so a redrive cannot loop a poisoned row
 * past its budget; otherwise the row returns to `pending` with the attempt
 * charged. Requires the row to still be `transferring`; a row that raced to
 * `consumed`/`dead_letter` is a no-op. Returns true iff the named row was
 * transferring and was acted on (re-pended or dead-lettered).
 */
export function redriveTransferringDurableWork(
	db: Database,
	id: string,
	maxAttempts: number,
	now = new Date().toISOString(),
): boolean {
	return instrument("redrive-transferring", "unknown", () => {
		const retention = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
		if (
			db.run(
				`UPDATE durable_work SET claim_state = 'dead_letter', claim_token = NULL, claimed_at = NULL,
		 last_error = 'transfer retries exhausted (no SPOOL_TRANSFER_ACK)', dead_lettered_at = ?, expires_at = ?
		 WHERE id = ? AND claim_state = 'transferring' AND attempt_count >= ?`,
				[now, retention, id, maxAttempts],
			).changes === 1
		)
			return true;
		return (
			db.run(
				`UPDATE durable_work SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL,
		 attempt_count = attempt_count + 1
		 WHERE id = ? AND claim_state = 'transferring' AND attempt_count < ?`,
				[id, maxAttempts],
			).changes === 1
		);
	});
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
 * transferred) and the {@link LOCAL_WORK_TARGET} sentinel (dispatch wakeups,
 * likewise in-process-only). Ordered oldest-first for a stable reconnect drain,
 * mirroring {@link readUndelivered} for the relay outbox.
 */
export function readPendingPeerTargetedDurableWork(
	db: Database,
	ownSiteId: string,
	targetSiteId?: string,
): DurableWorkRow[] {
	if (targetSiteId) {
		return db
			.query(
				`SELECT * FROM durable_work WHERE claim_state = 'pending' AND target_site_id = ? AND target_site_id != ? AND target_site_id != ? ORDER BY created_at`,
			)
			.all(targetSiteId, ownSiteId, LOCAL_WORK_TARGET) as DurableWorkRow[];
	}
	return db
		.query(
			`SELECT * FROM durable_work WHERE claim_state = 'pending' AND target_site_id != ? AND target_site_id != ? ORDER BY created_at`,
		)
		.all(ownSiteId, LOCAL_WORK_TARGET) as DurableWorkRow[];
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
				`SELECT * FROM durable_work WHERE claim_state = 'transferring' AND target_site_id = ? AND target_site_id != ? ORDER BY created_at`,
			)
			.all(targetSiteId, LOCAL_WORK_TARGET) as DurableWorkRow[];
	}
	return db
		.query(
			`SELECT * FROM durable_work WHERE claim_state = 'transferring' AND target_site_id != ? ORDER BY created_at`,
		)
		.all(LOCAL_WORK_TARGET) as DurableWorkRow[];
}
