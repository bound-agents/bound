import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTEXT_FILE_CANDIDATES,
	collectContextFiles,
	contextFileStaleNote,
	isContextFile,
} from "../context-files";
import { createEditTool } from "../edit";
import { createWriteTool } from "../write";

function blockText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

describe("isContextFile", () => {
	it("matches a default candidate by relative path", () => {
		expect(isContextFile("README.md", "/repo")).toBe(true);
		expect(isContextFile("CONTRIBUTING.md", "/repo")).toBe(true);
	});

	it("matches a default candidate by absolute path under cwd", () => {
		expect(isContextFile("/repo/AGENTS.md", "/repo")).toBe(true);
	});

	it("does not match a non-context file", () => {
		expect(isContextFile("src/index.ts", "/repo")).toBe(false);
		expect(isContextFile("readme.md", "/repo")).toBe(false); // case-sensitive
	});

	it("does not match a same-named file in a different directory", () => {
		expect(isContextFile("/other/README.md", "/repo")).toBe(false);
		expect(isContextFile("docs/README.md", "/repo")).toBe(false);
	});

	it("honors a custom candidate list", () => {
		expect(isContextFile("GUIDE.md", "/repo", ["GUIDE.md"])).toBe(true);
		expect(isContextFile("README.md", "/repo", ["GUIDE.md"])).toBe(false);
	});
});

describe("contextFileStaleNote", () => {
	it("names the file and warns against re-reading", () => {
		const note = contextFileStaleNote("README.md");
		expect(note).toContain("README.md");
		expect(note).toContain("do not re-read");
	});
});

describe("collectContextFiles XML delineation", () => {
	it("wraps a present file in a context-file node with path and mtime", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ctxfiles-"));
		try {
			writeFileSync(join(dir, "README.md"), "# Title\n");
			const result = await collectContextFiles(dir);
			expect(result).toContain("<context-files");
			expect(result).toContain('<context-file path="README.md"');
			expect(result).toMatch(/mtime="[0-9T:.Z-]+"/);
			expect(result).toContain("</context-file>");
			expect(result).toContain("</context-files>");
			// The frozen-copy note rides on the parent
			expect(result).toContain("FROZEN");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty string when no candidate files exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ctxfiles-empty-"));
		try {
			const result = await collectContextFiles(dir);
			expect(result).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("write/edit context-file steering note", () => {
	it("write tool appends the stale note when the target is a context file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ctxwrite-"));
		try {
			const write = createWriteTool("host", undefined, CONTEXT_FILE_CANDIDATES);
			const result = await write({ file_path: "README.md", content: "# Hi\n" }, undefined, dir);
			const text = blockText(result as never);
			expect(text).toContain("Wrote");
			expect(text).toContain("injected into your system prompt as a context file");
			expect(text).toContain("do not re-read");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("write tool omits the note for a non-context file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ctxwrite2-"));
		try {
			const write = createWriteTool("host", undefined, CONTEXT_FILE_CANDIDATES);
			const result = await write({ file_path: "src/index.ts", content: "x\n" }, undefined, dir);
			const text = blockText(result as never);
			expect(text).toContain("Wrote");
			expect(text).not.toContain("context file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("edit tool appends the stale note when the target is a context file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ctxedit-"));
		try {
			writeFileSync(join(dir, "AGENTS.md"), "old line\n");
			const edit = createEditTool("host", undefined, CONTEXT_FILE_CANDIDATES);
			const result = await edit(
				{ file_path: "AGENTS.md", old_string: "old line", new_string: "new line" },
				undefined,
				dir,
			);
			const text = blockText(result as never);
			expect(text).toContain("replaced 1 occurrence");
			expect(text).toContain("injected into your system prompt as a context file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
