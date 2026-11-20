/**
 * Test-only utilities shared across all packages.
 *
 * NOT exported from the shared barrel — import directly:
 *   import { cleanupTmpDir } from "@bound/shared/src/test-utils.js";
 */

import { rmSync } from "node:fs";

const RETRY_DELAY_MS = 100;
const MAX_RETRIES = 5;

/**
 * Remove a temporary directory with retry logic for Windows EBUSY errors.
 *
 * On Windows, SQLite WAL/SHM sidecar files and bun:sqlite handles may
 * retain file locks briefly after `db.close()`, causing EBUSY when
 * `rmSync` runs immediately in afterAll/afterEach. This helper retries
 * with a short delay between attempts.
 */
export async function cleanupTmpDir(path: string): Promise<void> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if ((code === "EBUSY" || code === "EPERM") && attempt < MAX_RETRIES) {
				await Bun.sleep(RETRY_DELAY_MS);
				continue;
			}
			// Final attempt or non-retryable error — swallow in cleanup.
			// Leaking a temp dir is better than failing a passing test.
			if (code === "EBUSY" || code === "EPERM") {
				return;
			}
			throw err;
		}
	}
}

/**
 * Synchronous form of {@link cleanupTmpDir} for sync hooks. Retries are
 * delegated to rmSync's own maxRetries; a lock that still outlives them is
 * swallowed, since leaking a temp dir is better than failing a passing test.
 */
export function cleanupTmpDirSync(path: string): void {
	try {
		rmSync(path, {
			recursive: true,
			force: true,
			maxRetries: MAX_RETRIES,
			retryDelay: RETRY_DELAY_MS,
		});
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EBUSY" || code === "EPERM") return;
		throw err;
	}
}
