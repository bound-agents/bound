import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTool } from "../tools/read";

describe("boundless_read", () => {
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

	it("AC5.1: returns line-numbered content with provenance prefix for valid file path", async () => {
		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "line one\nline two\nline three\n");

		const result = await readTool({ file_path: "test.txt" }, new AbortController().signal, tempDir);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const provenanceBlock = result.content[0];
		expect(provenanceBlock).toEqual({
			type: "text",
			text: expect.stringContaining("[boundless]"),
		});
		expect(provenanceBlock.text).toContain("tool=boundless_read");

		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("1\tline one");
		expect(contentBlock.text).toContain("2\tline two");
		expect(contentBlock.text).toContain("3\tline three");
	});

	it("AC5.2: returns specified line range with offset and limit", async () => {
		const testFile = join(tempDir, "multiline.txt");
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(testFile, lines);

		const result = await readTool(
			{ file_path: "multiline.txt", offset: 5, limit: 3 },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("5\tline 5");
		expect(contentBlock.text).toContain("6\tline 6");
		expect(contentBlock.text).toContain("7\tline 7");
		// Should not contain lines outside the range
		expect(contentBlock.text).not.toContain("4\tline 4");
		expect(contentBlock.text).not.toContain("8\tline 8");
	});

	it("AC5.3: returns error with ENOENT for nonexistent file", async () => {
		const result = await readTool(
			{ file_path: "nonexistent.txt" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBe(true);
		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Error");
		expect(contentBlock.text).toContain("ENOENT");
	});

	it("AC5.4: returns binary summary instead of raw content", async () => {
		const testFile = join(tempDir, "binary.bin");
		const buffer = Buffer.alloc(100);
		// Write a null byte at position 50 to make it binary
		buffer.writeUInt8(0, 50);
		writeFileSync(testFile, buffer);

		const result = await readTool(
			{ file_path: "binary.bin" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Binary file");
		expect(contentBlock.text).toContain("100 bytes");
		// Should not have line numbers (not text content)
		expect(contentBlock.text).not.toMatch(/^\s+\d+\t/m);
	});

	it("AC5.12: always includes provenance block first", async () => {
		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "test content\n");

		const result = await readTool({ file_path: "test.txt" }, new AbortController().signal, tempDir);

		expect(result.content.length).toBeGreaterThanOrEqual(1);
		const firstBlock = result.content[0];
		expect(firstBlock.type).toBe("text");
		expect(firstBlock.text).toContain("[boundless]");
		expect(firstBlock.text).toContain("boundless_read");
	});

	it("resolves relative paths correctly", async () => {
		const subdir = join(tempDir, "subdir");
		mkdirSync(subdir);
		const testFile = join(subdir, "test.txt");
		writeFileSync(testFile, "content");

		const result = await readTool(
			{ file_path: "subdir/test.txt" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("content");
	});

	it("handles absolute paths", async () => {
		const testFile = join(tempDir, "absolute.txt");
		writeFileSync(testFile, "absolute path content\n");

		const result = await readTool({ file_path: testFile }, new AbortController().signal, tempDir);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("absolute path content");
	});
});
