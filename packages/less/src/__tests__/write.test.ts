import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLED_SANDBOX, type ResolvedSandboxConfig } from "../tools/sandbox-policy";
import { createWriteTool, writeTool } from "../tools/write";

describe("boundless_write", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `boundless-test-${randomBytes(4).toString("hex")}`);
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

	it("rejects a missing file_path with a provenance-prefixed error", async () => {
		const result = await writeTool({ content: "x" }, new AbortController().signal, tempDir);
		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(2);
		const text = result.content[1] as { type: string; text: string };
		expect(text.text).toContain("file_path is required");
	});

	it("rejects missing content with a provenance-prefixed error", async () => {
		const result = await writeTool({ file_path: "a.txt" }, new AbortController().signal, tempDir);
		expect(result.isError).toBe(true);
		const text = result.content[1] as { type: string; text: string };
		expect(text.text).toContain("content is required");
	});

	it("surfaces a write error (e.g. target path is a directory)", async () => {
		// Make the resolved path an existing directory so renameSync/writeFileSync throws.
		const dirPath = "a-dir";
		mkdirSync(join(tempDir, dirPath), { recursive: true });
		const result = await writeTool(
			{ file_path: dirPath, content: "x" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		const text = result.content[1] as { type: string; text: string };
		expect(text.text).toContain("Error:");
	});

	it("blocks a direct write to the bound system database", async () => {
		const result = await writeTool(
			{ file_path: "bound.db", content: "malicious" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(existsSync(join(tempDir, "bound.db"))).toBe(false);
	});

	it("appends a context-file staleness note when writing an injected context file", async () => {
		const tool = createWriteTool("host-1", DISABLED_SANDBOX, ["AGENTS.md"]);
		const result = await tool(
			{ file_path: "AGENTS.md", content: "# agents" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBeUndefined();
		// provenance + wrote-bytes + stale note = 3 blocks
		expect(result.content).toHaveLength(3);
		const note = result.content[2] as { type: string; text: string };
		expect(note.text).toContain("AGENTS.md");
		expect(note.text.toLowerCase()).toContain("frozen");
	});

	it("denies a write outside the writable roots when the sandbox is enabled", async () => {
		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [tempDir],
			network: "open",
			onUnavailable: "error",
		};
		const tool = createWriteTool("host-1", sandbox);
		// Absolute path outside both cwd (tempDir) and the default-granted
		// tmpdir/root. homedir() is reliably outside tmpdir on every platform.
		const outside = join(homedir(), `.boundless-deny-test-${randomBytes(4).toString("hex")}.txt`);
		const result = await tool(
			{ file_path: outside, content: "x" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(existsSync(outside)).toBe(false);
	});

	it("allows a write inside the writable roots when the sandbox is enabled", async () => {
		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [tempDir],
			network: "open",
			onUnavailable: "error",
		};
		const tool = createWriteTool("host-1", sandbox);
		const result = await tool(
			{ file_path: "inside.txt", content: "ok" },
			new AbortController().signal,
			tempDir,
		);
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(tempDir, "inside.txt"), "utf-8")).toBe("ok");
	});
});
