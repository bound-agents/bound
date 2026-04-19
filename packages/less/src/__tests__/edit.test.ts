import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editTool } from "../tools/edit";

describe("boundless_edit", () => {
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

	it("AC5.6: replaces exactly one match of old_string with new_string", async () => {
		const testFile = join(tempDir, "test.txt");
		const originalContent = "hello world\nfoo bar\nbaz qux\n";
		writeFileSync(testFile, originalContent);

		const result = await editTool(
			{
				file_path: "test.txt",
				old_string: "foo bar",
				new_string: "replaced",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const provenanceBlock = result.content[0];
		expect(provenanceBlock.type).toBe("text");
		expect(provenanceBlock.text).toContain("[boundless]");
		expect(provenanceBlock.text).toContain("tool=boundless_edit");

		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Edited");
		expect(contentBlock.text).toContain("replaced 1 occurrence");

		// Verify file was actually changed
		const fileContent = readFileSync(testFile, "utf-8");
		expect(fileContent).toBe("hello world\nreplaced\nbaz qux\n");
	});

	it("AC5.7: returns error when old_string not found", async () => {
		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "hello world\nfoo bar\n");

		const result = await editTool(
			{
				file_path: "test.txt",
				old_string: "nonexistent",
				new_string: "replacement",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBe(true);
		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Error");
		expect(contentBlock.text).toContain("old_string not found");

		// Verify file was NOT changed
		const fileContent = readFileSync(testFile, "utf-8");
		expect(fileContent).toBe("hello world\nfoo bar\n");
	});

	it("AC5.8: returns error with match count when multiple matches found", async () => {
		const testFile = join(tempDir, "test.txt");
		const content = "foo bar\nfoo bar\nfoo bar\nbaz qux\n";
		writeFileSync(testFile, content);

		const result = await editTool(
			{
				file_path: "test.txt",
				old_string: "foo bar",
				new_string: "replaced",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBe(true);
		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Error");
		expect(contentBlock.text).toContain("3");
		expect(contentBlock.text).toContain("multiple matches");

		// Verify file was NOT changed
		const fileContent = readFileSync(testFile, "utf-8");
		expect(fileContent).toBe(content);
	});

	it("AC5.8: provides context for multiple matches", async () => {
		const testFile = join(tempDir, "test.txt");
		const content =
			"line 1\nMATCH here\nline 3\nline 4\nMATCH here\nline 6\nline 7\nMATCH here\nline 9\n";
		writeFileSync(testFile, content);

		const result = await editTool(
			{
				file_path: "test.txt",
				old_string: "MATCH here",
				new_string: "replaced",
			},
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("3 matches found");
	});

	it("AC5.12: always includes provenance block first", async () => {
		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "hello world\n");

		const result = await editTool(
			{
				file_path: "test.txt",
				old_string: "hello",
				new_string: "hi",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.content.length).toBeGreaterThanOrEqual(1);
		const firstBlock = result.content[0];
		expect(firstBlock.type).toBe("text");
		expect(firstBlock.text).toContain("[boundless]");
		expect(firstBlock.text).toContain("boundless_edit");
	});

	it("handles file at absolute path", async () => {
		const testFile = join(tempDir, "absolute.txt");
		writeFileSync(testFile, "content to edit\n");

		const result = await editTool(
			{
				file_path: testFile,
				old_string: "to edit",
				new_string: "edited",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.content[1].text).toContain("replaced 1 occurrence");
		const fileContent = readFileSync(testFile, "utf-8");
		expect(fileContent).toBe("content edited\n");
	});

	it("handles multiline old_string", async () => {
		const testFile = join(tempDir, "multiline.txt");
		const content = "line 1\nline 2\nline 3\nline 4\n";
		writeFileSync(testFile, content);

		const result = await editTool(
			{
				file_path: testFile,
				old_string: "line 2\nline 3",
				new_string: "replaced",
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.content[1].text).toContain("replaced 1 occurrence");
		const fileContent = readFileSync(testFile, "utf-8");
		expect(fileContent).toBe("line 1\nreplaced\nline 4\n");
	});
});
