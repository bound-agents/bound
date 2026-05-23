import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Compare `actual` against the snapshot at `snapshotPath`.
 *
 * On mismatch:
 *   - If `UPDATE_SNAPSHOTS=1` is set in the environment, the snapshot is overwritten
 *     and a console.warn explains. The caller's expectation passes.
 *   - Otherwise, throws a diff-shaped Error so bun:test reports a clean failure.
 *
 * On first run (snapshot file absent):
 *   - The file is written to disk and a console.warn names it as a new snapshot.
 *     The caller's expectation passes. Subsequent runs assert against the written file.
 *
 * The trailing newline of `actual` is preserved verbatim. Snapshot files are committed
 * to the repo; updating one is a deliberate review gate per spec §8.2.
 */
export function assertSnapshot(actual: string, snapshotPath: string): void {
	if (!existsSync(snapshotPath)) {
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(snapshotPath, actual, "utf8");
		console.warn(`[snapshot] wrote new fixture: ${snapshotPath}`);
		return;
	}
	const expected = readFileSync(snapshotPath, "utf8");
	if (actual === expected) return;
	if (process.env.UPDATE_SNAPSHOTS === "1") {
		writeFileSync(snapshotPath, actual, "utf8");
		console.warn(`[snapshot] updated fixture: ${snapshotPath}`);
		return;
	}
	throw new Error(snapshotMismatchMessage(snapshotPath, expected, actual));
}

function snapshotMismatchMessage(snapshotPath: string, expected: string, actual: string): string {
	const lines: string[] = [];
	lines.push(`Snapshot mismatch: ${snapshotPath}`);
	lines.push("To update, re-run with UPDATE_SNAPSHOTS=1 in the environment.");
	lines.push("---- expected ----");
	lines.push(expected);
	lines.push("---- actual ----");
	lines.push(actual);
	return lines.join("\n");
}
