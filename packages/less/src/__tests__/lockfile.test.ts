import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, readLock, releaseLock } from "../lockfile";

describe("lockfile", () => {
	let testDir: string;
	const testThreadId = "test-thread-123";

	beforeEach(() => {
		const hex = randomBytes(4).toString("hex");
		testDir = join(tmpdir(), `boundless-lockfile-test-${hex}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("acquireLock", () => {
		it("AC4.4: creates lock file with correct content for new thread", () => {
			const cwd = "/home/user";
			acquireLock(testDir, testThreadId, cwd);

			const lockPath = join(testDir, "locks", `${testThreadId}.json`);
			const content = readFileSync(lockPath, "utf-8");
			const lockData = JSON.parse(content) as Record<string, unknown>;

			expect(lockData.cwd).toBe(cwd);
			expect(lockData.pid).toBe(process.pid);
			expect(typeof lockData.attachedAt).toBe("string");

			// Verify attachedAt is valid ISO 8601
			expect(() => new Date(lockData.attachedAt as string)).not.toThrow();
		});

		it("AC4.5: clears stale lock and re-acquires", () => {
			const cwd = "/home/user";
			const staleLockData = JSON.stringify({
				cwd,
				pid: 999999, // Non-existent PID
				attachedAt: new Date().toISOString(),
			});
			const lockPath = join(testDir, "locks", `${testThreadId}.json`);

			// Create locks directory and stale lock
			mkdirSync(join(testDir, "locks"), { recursive: true });
			writeFileSync(lockPath, staleLockData);

			// Acquire should clear stale lock and create new one
			acquireLock(testDir, testThreadId, cwd);

			const content = readFileSync(lockPath, "utf-8");
			const lockData = JSON.parse(content) as Record<string, unknown>;

			expect(lockData.pid).toBe(process.pid);
		});

		it("AC4.6: throws when live pid with same cwd", () => {
			const cwd = "/home/user";
			const lockPath = join(testDir, "locks", `${testThreadId}.json`);

			// Manually create a lock with current PID
			mkdirSync(join(testDir, "locks"), { recursive: true });
			const lockData = JSON.stringify({
				cwd,
				pid: process.pid,
				attachedAt: new Date().toISOString(),
			});
			writeFileSync(lockPath, lockData);

			// Try to acquire with same cwd
			expect(() => acquireLock(testDir, testThreadId, cwd)).toThrow(
				`thread ${testThreadId} is already attached from this directory by pid ${process.pid}`,
			);
		});

		it("AC4.7: throws when live pid with different cwd", () => {
			const cwdA = "/home/user";
			const cwdB = "/tmp/other";
			const lockPath = join(testDir, "locks", `${testThreadId}.json`);

			// Manually create a lock with current PID and cwdA
			mkdirSync(join(testDir, "locks"), { recursive: true });
			const lockData = JSON.stringify({
				cwd: cwdA,
				pid: process.pid,
				attachedAt: new Date().toISOString(),
			});
			writeFileSync(lockPath, lockData);

			// Try to acquire with different cwd
			expect(() => acquireLock(testDir, testThreadId, cwdB)).toThrow(
				`thread ${testThreadId} is attached from ${cwdA} by pid ${process.pid}; you are in ${cwdB}`,
			);
		});

		it("handles corrupted lock file by treating as stale", () => {
			const cwd = "/home/user";
			const lockPath = join(testDir, "locks", `${testThreadId}.json`);

			// Create corrupted lock
			mkdirSync(join(testDir, "locks"), { recursive: true });
			writeFileSync(lockPath, "not valid json");

			// Should not throw, should re-acquire
			expect(() => acquireLock(testDir, testThreadId, cwd)).not.toThrow();

			// Verify new lock is created
			const content = readFileSync(lockPath, "utf-8");
			const lockData = JSON.parse(content) as Record<string, unknown>;
			expect(lockData.pid).toBe(process.pid);
		});
	});

	describe("releaseLock", () => {
		it("AC4.8: removes lock file on release", () => {
			const cwd = "/home/user";
			acquireLock(testDir, testThreadId, cwd);

			const lockPath = join(testDir, "locks", `${testThreadId}.json`);
			expect(() => readFileSync(lockPath, "utf-8")).not.toThrow();

			releaseLock(testDir, testThreadId);

			expect(() => readFileSync(lockPath, "utf-8")).toThrow();
		});

		it("doesn't throw if lock doesn't exist", () => {
			expect(() => releaseLock(testDir, testThreadId)).not.toThrow();
		});
	});

	describe("readLock", () => {
		it("returns null when lock doesn't exist", () => {
			const result = readLock(testDir, testThreadId);
			expect(result).toBeNull();
		});

		it("returns parsed lock data when lock exists", () => {
			const cwd = "/home/user";
			acquireLock(testDir, testThreadId, cwd);

			const result = readLock(testDir, testThreadId);
			expect(result).not.toBeNull();
			expect(result?.cwd).toBe(cwd);
			expect(result?.pid).toBe(process.pid);
			expect(typeof result?.attachedAt).toBe("string");
		});

		it("returns null for corrupted lock file", () => {
			const lockPath = join(testDir, "locks", `${testThreadId}.json`);
			mkdirSync(join(testDir, "locks"), { recursive: true });
			writeFileSync(lockPath, "not valid json");

			const result = readLock(testDir, testThreadId);
			expect(result).toBeNull();
		});
	});
});
