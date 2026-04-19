import {
	constants,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

export interface LockData {
	cwd: string;
	pid: number;
	attachedAt: string;
}

export function ensureLocksDir(configDir: string): void {
	mkdirSync(join(configDir, "locks"), { recursive: true });
}

export function acquireLock(configDir: string, threadId: string, cwd: string): void {
	ensureLocksDir(configDir);
	const lockPath = join(configDir, "locks", `${threadId}.json`);
	const lockData = JSON.stringify({
		cwd,
		pid: process.pid,
		attachedAt: new Date().toISOString(),
	});

	try {
		// Try to create the lock file atomically with O_EXCL
		const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
		writeSync(fd, lockData);
		closeSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
			// Lock file already exists, check if the PID is still alive
			const existingContent = readFileSync(lockPath, "utf-8");
			let existingLock: LockData;
			try {
				existingLock = JSON.parse(existingContent) as LockData;
			} catch {
				// Corrupted lock file, treat as stale
				unlinkSync(lockPath);
				acquireLock(configDir, threadId, cwd);
				return;
			}

			// Check if the PID is still alive
			try {
				process.kill(existingLock.pid, 0);
				// Process is alive, check cwd mismatch
				if (existingLock.cwd === cwd) {
					throw new Error(
						`thread ${threadId} is already attached from this directory by pid ${existingLock.pid}`,
					);
				}
				throw new Error(
					`thread ${threadId} is attached from ${existingLock.cwd} by pid ${existingLock.pid}; you are in ${cwd}`,
				);
			} catch (killError) {
				if ((killError as NodeJS.ErrnoException)?.code === "ESRCH") {
					// Process is dead, stale lock - remove and retry
					unlinkSync(lockPath);
					acquireLock(configDir, threadId, cwd);
					return;
				}
				// Re-throw our custom error
				throw killError;
			}
		}
		// Re-throw other errors
		throw error;
	}
}

export function releaseLock(configDir: string, threadId: string): void {
	try {
		unlinkSync(join(configDir, "locks", `${threadId}.json`));
	} catch {
		// Silent failure is fine - lock may already be cleaned up
	}
}

export function readLock(configDir: string, threadId: string): LockData | null {
	const lockPath = join(configDir, "locks", `${threadId}.json`);
	try {
		const content = readFileSync(lockPath, "utf-8");
		return JSON.parse(content) as LockData;
	} catch {
		return null;
	}
}
