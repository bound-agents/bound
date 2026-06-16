/**
 * SDK-free state persistence and orphan-sweep logic for the boundless
 * IsolationSession sandbox backend (Windows).
 *
 * This module holds NO dependency on @microsoft/mxc-sdk so it can be unit
 * tested without a live sandbox. The SDK-dependent manager (iso-session.ts)
 * provisions/deprovisions sessions and calls into here to record them.
 *
 * Why a state file at all: an IsolationSession provisions a Windows agent
 * user with an Indefinite lifetime. A boundless process that dies between
 * provision and deprovision orphans that account (and its broker process)
 * with nothing on the books to reap it. We persist every live session here so
 * a later boundless startup can sweep orphans left by a prior hard kill.
 *
 * Critical safety property: the sweep reaps ONLY records whose owning
 * boundless pid is dead. A concurrent live boundless instance has its own
 * record (its own agent user + sandboxId, sharing only the broker singleton),
 * and must never have its session reaped out from under it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface IsoSessionRecord {
	/** mxc sandbox id, e.g. "iso:wxc-6b448a02" — the deprovision handle. */
	sandboxId: string;
	/** Windows agent user the broker minted, e.g. "A6-Y7" (for diagnostics). */
	agentUser: string | undefined;
	/** pid of the boundless process that owns this session. */
	ownerPid: number;
	/** working directory the session was provisioned for. */
	cwd: string;
	/** ISO 8601 provision timestamp. */
	createdAt: string;
}

/** A record is structurally valid iff it carries the load-bearing fields. */
function isRecord(value: unknown): value is IsoSessionRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return typeof r.sandboxId === "string" && typeof r.ownerPid === "number";
}

/**
 * Load the persisted session records. Returns [] on any failure mode —
 * missing file, corrupt JSON, or valid JSON of the wrong shape — because a
 * malformed state file must never crash boundless startup; the worst case of
 * ignoring it is an orphan that lingers until the next clean sweep.
 */
export function loadIsoSessions(statePath: string): IsoSessionRecord[] {
	let raw: string;
	try {
		raw = readFileSync(statePath, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isRecord);
}

/**
 * Overwrite the state file atomically: write a sibling temp file, then rename
 * over the target. rename is atomic on a single volume, so a crash mid-write
 * can never leave a half-written state file that loadIsoSessions would discard
 * (taking live records down with it).
 */
export function writeIsoSessions(statePath: string, records: IsoSessionRecord[]): void {
	mkdirSync(dirname(statePath), { recursive: true });
	const tmp = join(dirname(statePath), `.iso-sessions.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
	renameSync(tmp, statePath);
}

/**
 * Append a session record, de-duped on sandboxId (last write wins). Used at
 * provision time. Read-modify-write against the on-disk set so a record from a
 * concurrent instance is preserved rather than clobbered.
 */
export function recordIsoSession(statePath: string, record: IsoSessionRecord): void {
	const existing = loadIsoSessions(statePath).filter((r) => r.sandboxId !== record.sandboxId);
	existing.push(record);
	writeIsoSessions(statePath, existing);
}

/** Drop a session by sandboxId. Used after a clean deprovision. No-op if absent. */
export function removeIsoSession(statePath: string, sandboxId: string): void {
	const remaining = loadIsoSessions(statePath).filter((r) => r.sandboxId !== sandboxId);
	writeIsoSessions(statePath, remaining);
}

/**
 * Select the records eligible for reaping: those whose owning pid is dead.
 * `isAlive` is injected (the SDK-dependent caller passes a real liveness probe)
 * so this stays pure and testable. A record whose owner is alive is NEVER
 * selected — that is the concurrent-instance safety guarantee.
 */
export function selectOrphans(
	records: IsoSessionRecord[],
	isAlive: (pid: number) => boolean,
): IsoSessionRecord[] {
	return records.filter((r) => !isAlive(r.ownerPid));
}
