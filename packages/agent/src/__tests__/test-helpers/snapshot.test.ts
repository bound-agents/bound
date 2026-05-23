import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { assertSnapshot } from "./snapshot";

describe("assertSnapshot", () => {
	let tmpDir: string;

	afterEach(async () => {
		await cleanupTmpDir(tmpDir);
	});

	it("first run writes the fixture", () => {
		tmpDir = join(tmpdir(), `snapshot-test-${randomBytes(4).toString("hex")}`);
		const snapshotPath = join(tmpDir, "test.snap.txt");

		assertSnapshot("hello\n", snapshotPath);

		expect(existsSync(snapshotPath)).toBe(true);
	});

	it("match passes silently", () => {
		tmpDir = join(tmpdir(), `snapshot-test-${randomBytes(4).toString("hex")}`);
		const snapshotPath = join(tmpDir, "test.snap.txt");

		assertSnapshot("hello\n", snapshotPath);
		// Second call with same content should pass without throwing
		assertSnapshot("hello\n", snapshotPath);

		expect(true).toBe(true);
	});

	it("mismatch throws with diff-shaped message", () => {
		tmpDir = join(tmpdir(), `snapshot-test-${randomBytes(4).toString("hex")}`);
		const snapshotPath = join(tmpDir, "test.snap.txt");

		assertSnapshot("hello\n", snapshotPath);

		expect(() => {
			assertSnapshot("world\n", snapshotPath);
		}).toThrow();

		try {
			assertSnapshot("world\n", snapshotPath);
		} catch (e) {
			const message = (e as Error).message;
			expect(message).toContain(snapshotPath);
			expect(message).toContain("hello");
			expect(message).toContain("world");
			expect(message).toContain("---- expected ----");
			expect(message).toContain("---- actual ----");
		}
	});

	it("UPDATE_SNAPSHOTS=1 overwrites and passes", () => {
		tmpDir = join(tmpdir(), `snapshot-test-${randomBytes(4).toString("hex")}`);
		const snapshotPath = join(tmpDir, "test.snap.txt");
		const originalEnv = process.env.UPDATE_SNAPSHOTS;

		try {
			assertSnapshot("hello\n", snapshotPath);

			process.env.UPDATE_SNAPSHOTS = "1";
			assertSnapshot("world\n", snapshotPath);

			// Verify the file was overwritten
			const fs = require("node:fs");
			const content = fs.readFileSync(snapshotPath, "utf8");
			expect(content).toBe("world\n");
		} finally {
			process.env.UPDATE_SNAPSHOTS = originalEnv;
		}
	});

	it("trailing newline preserved", () => {
		tmpDir = join(tmpdir(), `snapshot-test-${randomBytes(4).toString("hex")}`);
		const snapshotPath = join(tmpDir, "test.snap.txt");

		// Write without trailing newline
		assertSnapshot("x", snapshotPath);

		// Same content matches
		assertSnapshot("x", snapshotPath);

		// With trailing newline does not match
		expect(() => {
			assertSnapshot("x\n", snapshotPath);
		}).toThrow();
	});

	it("nested directory created on first write", () => {
		tmpDir = join(tmpdir(), `snapshot-test-${randomBytes(4).toString("hex")}`);
		const snapshotPath = join(tmpDir, "nested", "dir", "test.snap.txt");

		assertSnapshot("nested content\n", snapshotPath);

		expect(existsSync(snapshotPath)).toBe(true);
	});
});
