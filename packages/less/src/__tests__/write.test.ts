import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeTool } from "../tools/write";

describe("boundless_write", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join("/tmp", `boundless-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("AC5.5: creates file with parent directories and returns byte count", async () => {
		const testPath = "deeply/nested/path/file.txt";
		const testContent = "Hello, World!";

		const result = await writeTool(
			{ file_path: testPath, content: testContent },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();

		// Check provenance block
		const provenanceBlock = result.content[0];
		expect(provenanceBlock.type).toBe("text");
		expect(provenanceBlock.text).toContain("[boundless]");
		expect(provenanceBlock.text).toContain("tool=boundless_write");

		// Check result message
		const resultBlock = result.content[1];
		expect(resultBlock.type).toBe("text");
		expect(resultBlock.text).toContain("Wrote");
		expect(resultBlock.text).toContain("bytes to");
		expect(resultBlock.text).toContain(testPath);

		// Verify byte count
		const expectedBytes = Buffer.byteLength(testContent, "utf-8");
		expect(resultBlock.text).toContain(String(expectedBytes));

		// Verify file was actually created with correct content
		const fullPath = join(tempDir, testPath);
		expect(existsSync(fullPath)).toBe(true);
		const readContent = readFileSync(fullPath, "utf-8");
		expect(readContent).toBe(testContent);

		// Verify parent directories exist
		const parentDir = join(tempDir, "deeply/nested/path");
		expect(existsSync(parentDir)).toBe(true);
	});

	it("AC5.12: always includes provenance block first", async () => {
		const testPath = "simple.txt";
		const testContent = "test";

		const result = await writeTool(
			{ file_path: testPath, content: testContent },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content.length).toBeGreaterThanOrEqual(1);
		const firstBlock = result.content[0];
		expect(firstBlock.type).toBe("text");
		expect(firstBlock.text).toContain("[boundless]");
		expect(firstBlock.text).toContain("boundless_write");
	});

	it("overwrites existing file", async () => {
		const testPath = "overwrite.txt";
		const originalContent = "original";
		const newContent = "new content";

		// Write initial file
		await writeTool(
			{ file_path: testPath, content: originalContent },
			new AbortController().signal,
			tempDir,
		);

		// Overwrite it
		await writeTool(
			{ file_path: testPath, content: newContent },
			new AbortController().signal,
			tempDir,
		);

		// Verify new content
		const fullPath = join(tempDir, testPath);
		const readContent = readFileSync(fullPath, "utf-8");
		expect(readContent).toBe(newContent);
	});

	it("handles absolute paths", async () => {
		const absolutePath = join(tempDir, "absolute_file.txt");
		const testContent = "absolute path content";

		const result = await writeTool(
			{ file_path: absolutePath, content: testContent },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		expect(existsSync(absolutePath)).toBe(true);
		const readContent = readFileSync(absolutePath, "utf-8");
		expect(readContent).toBe(testContent);
	});

	it("handles UTF-8 content with multi-byte characters", async () => {
		const testPath = "utf8.txt";
		const testContent = "Hello 世界 🌍";

		await writeTool(
			{ file_path: testPath, content: testContent },
			new AbortController().signal,
			tempDir,
		);

		const fullPath = join(tempDir, testPath);
		const readContent = readFileSync(fullPath, "utf-8");
		expect(readContent).toBe(testContent);

		// Verify byte count is correct
		const result = await writeTool(
			{ file_path: testPath, content: testContent },
			new AbortController().signal,
			tempDir,
		);
		const resultBlock = result.content[1];
		const expectedBytes = Buffer.byteLength(testContent, "utf-8");
		expect(resultBlock.text).toContain(String(expectedBytes));
	});

	it("creates parent directory when it doesn't exist", async () => {
		const testPath = "new/dir/structure/file.txt";
		const testContent = "content";

		const parentDirPath = join(tempDir, "new/dir/structure");
		expect(existsSync(parentDirPath)).toBe(false);

		await writeTool(
			{ file_path: testPath, content: testContent },
			new AbortController().signal,
			tempDir,
		);

		expect(existsSync(parentDirPath)).toBe(true);
		const fullPath = join(tempDir, testPath);
		expect(existsSync(fullPath)).toBe(true);
	});

	it("handles empty content", async () => {
		const testPath = "empty.txt";
		const testContent = "";

		const result = await writeTool(
			{ file_path: testPath, content: testContent },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const fullPath = join(tempDir, testPath);
		expect(existsSync(fullPath)).toBe(true);
		const readContent = readFileSync(fullPath, "utf-8");
		expect(readContent).toBe("");
	});
});
