import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Guard against direct access to the bound system database from boundless
 * file tools (#207).
 *
 * Direct writes to the SQLite file bypass the change-log outbox, soft-deletion
 * semantics, and trigger maintenance (FTS shadow tables), so they can corrupt
 * sync state in ways that only surface later on another host. Reads are
 * merely a worse tool for the job — the `query` tool answers the same
 * questions against the live connection without racing the WAL.
 *
 * Detection is heuristic (v1): the daemon's real dbPath is not threaded into
 * the session yet, so we match the conventional shapes instead:
 *
 *   - `bound.db` (plus `-wal` / `-shm` / `-journal` siblings) anywhere
 *   - any `.db` / `.sqlite` / `.sqlite3` file (plus WAL/SHM siblings) that
 *     sits under a directory named `data` — the layout `bound init` produces
 *
 * A `.db` file elsewhere (a fixture in a repo, a game asset) stays untouched.
 */

/** `bound.db`, `bound.db-wal`, `bound.db-shm`, `bound.db-journal` — any casing. */
const BOUND_DB_RE = /^bound\.db(?:-wal|-shm|-journal)?$/i;

/** Generic SQLite shapes: x.db / x.sqlite / x.sqlite3 (+ -wal/-shm/-journal). */
const SQLITE_FILE_RE = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$/i;

/** True when the path looks like the bound system database (see module doc). */
export function isBoundDbPath(filePath: string, cwd: string): boolean {
	const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const name = basename(resolved);
	if (BOUND_DB_RE.test(name)) return true;
	if (SQLITE_FILE_RE.test(name)) {
		return basename(dirname(resolved)).toLowerCase() === "data";
	}
	return false;
}

/**
 * Write/edit guard: returns the refusal text when the target is the system
 * DB, null otherwise. Callers return this as an isError result.
 */
export function checkDbWrite(toolName: string, filePath: string, cwd: string): string | null {
	if (!isBoundDbPath(filePath, cwd)) return null;
	return `${toolName}: refusing to write to ${filePath} — this looks like the bound system database. Direct writes bypass the change-log outbox, soft-deletion semantics, and FTS triggers, and can silently corrupt sync state. Make the change through code that uses bound's helper functions (insertRow/updateRow/softDelete), or at minimum a script that reuses them.`;
}

/**
 * Read/copy guard: returns an advisory note when the target is the system DB,
 * null otherwise. Callers append this to a successful result — reading is not
 * blocked, just redirected toward the better tool.
 */
export function checkDbRead(filePath: string, cwd: string): string | null {
	if (!isBoundDbPath(filePath, cwd)) return null;
	return `[db-guard] ${filePath} looks like the bound system database. Prefer the \`query\` tool — it reads the live connection instead of racing the WAL, and returns structured rows.`;
}

/**
 * Bash command guard: returns an advisory note when the command line invokes
 * a SQLite CLI or names the bound DB file, null otherwise. Warn-only — shell
 * command shapes are too varied to pattern-block without false positives.
 */
export function checkDbCommand(command: string): string | null {
	// `sqlite3` / `sqlite` as a command token (start of line or after a
	// separator), or `bound.db` appearing as an argument anywhere.
	const invokesSqliteCli = /(?:^|[\s;|&(])sqlite3?\s/i.test(command);
	const namesBoundDb = /bound\.db(?:-wal|-shm|-journal)?\b/i.test(command);
	if (!invokesSqliteCli && !namesBoundDb) return null;
	return (
		"[db-guard] This command appears to touch the bound system database directly. " +
		"Reads belong in the `query` tool; writes must go through bound's helper functions " +
		"(direct SQLite writes bypass soft-deletion and sync triggers). Proceeding anyway."
	);
}
