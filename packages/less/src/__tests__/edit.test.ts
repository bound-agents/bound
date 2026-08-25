import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLineHash } from "@bound/shared";
import { editTool } from "../tools/edit";

/** Build a "LINE:HASH" anchor for a given line of content. */
function anchor(line: number, text: string): string {
	return `${line}:${computeLineHash(text)}`;
}

describe("boundless_edit (hashline)", () => {
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

	it("replaces a single line addressed by anchor", async () => {
		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "hello world\nfoo bar\nbaz qux\n");

		const result = await editTool(
			{
				file_path: "test.txt",
				edits: [{ start: anchor(2, "foo bar"), end: anchor(2, "foo bar"), content: "replaced" }],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		const provenanceBlock = result.content[0];
		expect(provenanceBlock.type).toBe("text");
		expect(provenanceBlock.text).toContain("[boundless]");
		expect(provenanceBlock.text).toContain("tool=boundless_edit");

		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Edited");

		expect(readFileSync(testFile, "utf-8")).toBe("hello world\nreplaced\nbaz qux\n");
	});

	it("replaces a range of lines between two anchors", async () => {
		const testFile = join(tempDir, "range.txt");
		writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\n");

		const result = await editTool(
			{
				file_path: testFile,
				edits: [{ start: anchor(2, "line 2"), end: anchor(3, "line 3"), content: "replaced" }],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(readFileSync(testFile, "utf-8")).toBe("line 1\nreplaced\nline 4\n");
	});

	it("applies multiple edits in one call atomically", async () => {
		const testFile = join(tempDir, "multi.txt");
		writeFileSync(testFile, "aaa\nbbb\nccc\nddd\n");

		const result = await editTool(
			{
				file_path: testFile,
				edits: [
					{ start: anchor(1, "aaa"), end: anchor(1, "aaa"), content: "AAA" },
					{ start: anchor(4, "ddd"), end: anchor(4, "ddd"), content: "DDD" },
				],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(readFileSync(testFile, "utf-8")).toBe("AAA\nbbb\nccc\nDDD\n");
	});

	it("recovers via proximity when lines shifted since the anchor was read", async () => {
		const testFile = join(tempDir, "shift.txt");
		// Anchor captured for "target" when it was on line 2...
		const a = anchor(2, "target");
		// ...but the file has since gained two lines above it.
		writeFileSync(testFile, "// new header\n// more header\nintro\ntarget\ntail\n");

		const result = await editTool(
			{ file_path: testFile, edits: [{ start: a, end: a, content: "TARGET" }] },
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(readFileSync(testFile, "utf-8")).toBe(
			"// new header\n// more header\nintro\nTARGET\ntail\n",
		);
	});

	it("disambiguates duplicate lines by proximity to the line hint", async () => {
		const testFile = join(tempDir, "dup.txt");
		writeFileSync(testFile, "x\nreturn 1;\ny\nz\nreturn 1;\nw\n");

		const result = await editTool(
			{
				file_path: testFile,
				edits: [
					{ start: anchor(5, "return 1;"), end: anchor(5, "return 1;"), content: "return 2;" },
				],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(readFileSync(testFile, "utf-8")).toBe("x\nreturn 1;\ny\nz\nreturn 2;\nw\n");
	});

	it("returns an error with a re-read hint when an anchor's hash is not found", async () => {
		const testFile = join(tempDir, "test.txt");
		const content = "hello world\nfoo bar\n";
		writeFileSync(testFile, content);

		const result = await editTool(
			{
				file_path: "test.txt",
				edits: [{ start: "1:ffff", end: "1:ffff", content: "replacement" }],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBe(true);
		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("Error");
		expect(contentBlock.text).toContain("not found");
		expect(contentBlock.text).toContain("re-read");

		// File NOT changed.
		expect(readFileSync(testFile, "utf-8")).toBe(content);
	});

	it("uses 0000 from a read as the anchor for a blank line", async () => {
		const testFile = join(tempDir, "blank.txt");
		writeFileSync(testFile, "before\n\nafter\n");

		const result = await editTool(
			{
				file_path: "blank.txt",
				edits: [{ start: "2:0000", end: "2:0000", content: "between" }],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		expect(readFileSync(testFile, "utf-8")).toBe("before\nbetween\nafter\n");
	});

	it("rejects the whole batch when any edit fails (atomicity)", async () => {
		const testFile = join(tempDir, "atomic.txt");
		const content = "aaa\nbbb\nccc\n";
		writeFileSync(testFile, content);

		const result = await editTool(
			{
				file_path: testFile,
				edits: [
					{ start: anchor(1, "aaa"), end: anchor(1, "aaa"), content: "AAA" },
					{ start: "2:ffff", end: "2:ffff", content: "nope" },
				],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBe(true);
		expect(readFileSync(testFile, "utf-8")).toBe(content);
	});

	it("validates required args", async () => {
		const noPath = await editTool(
			{ edits: [{ start: "1:abcd", end: "1:abcd", content: "x" }] },
			new AbortController().signal,
			tempDir,
		);
		expect(noPath.isError).toBe(true);
		expect(noPath.content[1].text).toContain("file_path");

		const noEdits = await editTool(
			{ file_path: "whatever.txt" },
			new AbortController().signal,
			tempDir,
		);
		expect(noEdits.isError).toBe(true);
		expect(noEdits.content[1].text).toContain("edits");

		const badEdit = await editTool(
			{ file_path: "whatever.txt", edits: [{ start: "1:abcd" }] },
			new AbortController().signal,
			tempDir,
		);
		expect(badEdit.isError).toBe(true);
	});

	it("always includes provenance block first", async () => {
		const testFile = join(tempDir, "test.txt");
		writeFileSync(testFile, "hello world\n");

		const result = await editTool(
			{
				file_path: "test.txt",
				edits: [{ start: anchor(1, "hello world"), end: anchor(1, "hello world"), content: "hi" }],
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

	it("reports the resulting line range with fresh anchors after an edit", async () => {
		const testFile = join(tempDir, "fresh.txt");
		writeFileSync(testFile, "one\ntwo\nthree\n");

		const result = await editTool(
			{
				file_path: testFile,
				edits: [{ start: anchor(2, "two"), end: anchor(2, "two"), content: "TWO-A\nTWO-B" }],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBeUndefined();
		// The result should carry fresh anchors for the replaced region so the
		// model can chain edits without a re-read.
		const text = result.content[1].text;
		expect(text).toContain(`2:${computeLineHash("TWO-A")}|TWO-A`);
		expect(text).toContain(`3:${computeLineHash("TWO-B")}|TWO-B`);
	});

	it("provides a recovery hint when file does not exist", async () => {
		const result = await editTool(
			{
				file_path: "does-not-exist.ts",
				edits: [{ start: "1:abcd", end: "1:abcd", content: "bar" }],
			},
			new AbortController().signal,
			tempDir,
		);

		expect(result.isError).toBe(true);
		const errorBlock = result.content[1];
		expect(errorBlock.text).toContain("File not found");
		expect(errorBlock.text).toContain("write");
	});
});
