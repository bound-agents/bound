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

	it("returns image ContentBlock for PNG files", async () => {
		// Minimal valid 1x1 PNG (67 bytes)
		const pngBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		const testFile = join(tempDir, "screenshot.png");
		writeFileSync(testFile, pngBytes);

		const result = await readTool(
			{ file_path: "screenshot.png" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		// Should have provenance + image block
		const imageBlock = result.content.find((b) => b.type === "image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock?.source?.type).toBe("base64");
		expect(imageBlock?.source?.media_type).toBe("image/png");
		expect(imageBlock?.source?.data).toBe(pngBytes.toString("base64"));
	});

	it("returns image ContentBlock for JPEG files", async () => {
		// Minimal JPEG header (SOI marker + APP0 marker)
		const jpegBytes = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
			0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
		]);
		const testFile = join(tempDir, "photo.jpg");
		writeFileSync(testFile, jpegBytes);

		const result = await readTool(
			{ file_path: "photo.jpg" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		const imageBlock = result.content.find((b) => b.type === "image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock?.source?.media_type).toBe("image/jpeg");
	});

	it("returns image ContentBlock for WebP files", async () => {
		// Minimal WebP header (RIFF + WEBP)
		const webpBytes = Buffer.from([
			0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
			0x20, 0x18, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
			0x01, 0x40, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0x94, 0x00, 0x00,
		]);
		const testFile = join(tempDir, "image.webp");
		writeFileSync(testFile, webpBytes);

		const result = await readTool(
			{ file_path: "image.webp" },
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		const imageBlock = result.content.find((b) => b.type === "image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock?.source?.media_type).toBe("image/webp");
	});

	it("falls back to binary summary for non-image binary files", async () => {
		const binaryFile = join(tempDir, "data.bin");
		const buffer = Buffer.alloc(100);
		buffer.writeUInt8(0, 50);
		writeFileSync(binaryFile, buffer);

		const result = await readTool({ file_path: "data.bin" }, new AbortController().signal, tempDir);

		expect(result.isError).toBeUndefined();
		// Should NOT have an image block
		const imageBlock = result.content.find((b) => b.type === "image");
		expect(imageBlock).toBeUndefined();
		// Should have the binary text summary
		const textBlock = result.content.find(
			(b) => b.type === "text" && b.text?.includes("Binary file"),
		);
		expect(textBlock).toBeDefined();
	});
});
