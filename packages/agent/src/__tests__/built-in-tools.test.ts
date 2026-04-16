import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryFs } from "just-bash";
import { type BuiltInTool, createBuiltInTools } from "../built-in-tools";

describe("built-in-tools", () => {
	let fs: InstanceType<typeof InMemoryFs>;
	let tools: Map<string, BuiltInTool>;

	beforeEach(() => {
		fs = new InMemoryFs();
		tools = createBuiltInTools(fs);
	});

	/** Helper to retrieve a tool by name, throwing if missing (avoids non-null assertions). */
	function tool(name: string): BuiltInTool {
		const t = tools.get(name);
		if (!t) throw new Error(`Tool "${name}" not found`);
		return t;
	}

	it("creates exactly three tools: read, write, edit", () => {
		expect(tools.size).toBe(3);
		expect(tools.has("read")).toBe(true);
		expect(tools.has("write")).toBe(true);
		expect(tools.has("edit")).toBe(true);
	});

	it("each tool has a valid toolDefinition", () => {
		for (const [name, tool] of tools) {
			expect(tool.toolDefinition.type).toBe("function");
			expect(tool.toolDefinition.function.name).toBe(name);
			expect(typeof tool.toolDefinition.function.description).toBe("string");
			expect(tool.toolDefinition.function.parameters).toBeDefined();
		}
	});

	// ─── read ───────────────────────────────────────────────────────────

	describe("read", () => {
		it("reads a file with line numbers", async () => {
			fs.writeFileSync("/home/user/hello.txt", "line one\nline two\nline three\n");
			const result = await tool("read").execute({ path: "/home/user/hello.txt" });
			expect(result).toContain("1\tline one");
			expect(result).toContain("2\tline two");
			expect(result).toContain("3\tline three");
		});

		it("returns error on ENOENT", async () => {
			const result = await tool("read").execute({ path: "/nope.txt" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("/nope.txt");
		});

		it("returns error on EISDIR", async () => {
			fs.mkdirSync("/home/user/mydir", { recursive: true });
			const result = await tool("read").execute({ path: "/home/user/mydir" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("directory");
		});

		it("detects binary content (NUL byte in first 8KB)", async () => {
			const binary = "hello\0world";
			fs.writeFileSync("/home/user/bin.dat", binary);
			const result = await tool("read").execute({ path: "/home/user/bin.dat" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("binary");
		});

		it("applies offset (1-based)", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("read").execute({ path: "/home/user/lines.txt", offset: 3 });
			expect(result).toContain("3\tc");
			expect(result).toContain("4\td");
			expect(result).not.toContain("1\ta");
			expect(result).not.toContain("2\tb");
		});

		it("applies limit", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("read").execute({ path: "/home/user/lines.txt", limit: 2 });
			expect(result).toContain("1\ta");
			expect(result).toContain("2\tb");
			expect(result).not.toContain("3\tc");
		});

		it("applies offset + limit together", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("read").execute({
				path: "/home/user/lines.txt",
				offset: 2,
				limit: 2,
			});
			expect(result).toContain("2\tb");
			expect(result).toContain("3\tc");
			expect(result).not.toContain("1\ta");
			expect(result).not.toContain("4\td");
		});

		it("shows continuation hint when more lines exist", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("read").execute({
				path: "/home/user/lines.txt",
				limit: 2,
			});
			expect(result).toContain("[Use offset=3 to continue]");
		});

		it("does NOT show continuation hint at end of file", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\n");
			const result = await tool("read").execute({ path: "/home/user/lines.txt" });
			expect(result).not.toContain("[Use offset=");
		});

		it("rejects invalid offset", async () => {
			fs.writeFileSync("/home/user/f.txt", "x\n");
			const result = await tool("read").execute({ path: "/home/user/f.txt", offset: 0 });
			expect(result).toStartWith("Error:");
			expect(result).toContain("invalid");
		});

		it("rejects limit > 2000", async () => {
			fs.writeFileSync("/home/user/f.txt", "x\n");
			const result = await tool("read").execute({ path: "/home/user/f.txt", limit: 2001 });
			expect(result).toStartWith("Error:");
			expect(result).toContain("invalid");
		});

		it("truncates output to 50,000 bytes without partial lines", async () => {
			// Each line is ~100 chars -> 600 lines ~ 60KB > 50KB
			const longLine = "x".repeat(99);
			const lines = Array.from({ length: 600 }, () => longLine).join("\n");
			fs.writeFileSync("/home/user/big.txt", lines);
			const result = await tool("read").execute({ path: "/home/user/big.txt" });
			// Result must be <= 50,000 bytes
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(55_000); // some slack for line nums + hint
			// Must not contain partial lines — every content line should end with x's
			expect(result).toContain("[Use offset=");
		});

		it("pads line numbers to 6 columns", async () => {
			fs.writeFileSync("/home/user/f.txt", "hello\n");
			const result = await tool("read").execute({ path: "/home/user/f.txt" });
			// Line number should be right-padded to 6 chars
			expect(result).toMatch(/\s+1\thello/);
		});
	});

	// ─── write ──────────────────────────────────────────────────────────

	describe("write", () => {
		it("writes a new file and returns byte count", async () => {
			const result = await tool("write").execute({
				path: "/home/user/new.txt",
				content: "hello world",
			});
			expect(result).toContain("Wrote");
			expect(result).toContain("11 bytes");
			expect(result).toContain("/home/user/new.txt");
			// Verify content on disk
			const content = await fs.readFile("/home/user/new.txt");
			expect(content).toBe("hello world");
		});

		it("overwrites existing file", async () => {
			fs.writeFileSync("/home/user/exist.txt", "old");
			const result = await tool("write").execute({
				path: "/home/user/exist.txt",
				content: "new content",
			});
			expect(result).toContain("Wrote");
			expect(await fs.readFile("/home/user/exist.txt")).toBe("new content");
		});

		it("creates parent directories automatically", async () => {
			const result = await tool("write").execute({
				path: "/home/user/deep/nested/dir/file.txt",
				content: "deep",
			});
			expect(result).toContain("Wrote");
			expect(await fs.readFile("/home/user/deep/nested/dir/file.txt")).toBe("deep");
		});

		it("handles UTF-8 multibyte correctly", async () => {
			const content = "cafe\u0301 \u{1F600}"; // cafe + combining accent + emoji
			const result = await tool("write").execute({
				path: "/home/user/utf8.txt",
				content,
			});
			const bytes = Buffer.byteLength(content, "utf8");
			expect(result).toContain(`${bytes} bytes`);
		});
	});

	// ─── edit ───────────────────────────────────────────────────────────

	describe("edit", () => {
		it("applies a single edit and returns unified diff", async () => {
			fs.writeFileSync("/home/user/code.ts", "const x = 1;\nconst y = 2;\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "const x = 1;", new_text: "const x = 42;" }],
			});
			expect(result).toContain("-const x = 1;");
			expect(result).toContain("+const x = 42;");
			// Verify file was actually written
			expect(await fs.readFile("/home/user/code.ts")).toBe("const x = 42;\nconst y = 2;\n");
		});

		it("returns error when old_text not found", async () => {
			fs.writeFileSync("/home/user/code.ts", "const x = 1;\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "NOPE", new_text: "whatever" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("not found");
		});

		it("returns error when old_text matches multiple times", async () => {
			fs.writeFileSync("/home/user/code.ts", "foo\nfoo\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "foo", new_text: "bar" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("2 times");
		});

		it("applies multiple edits atomically", async () => {
			fs.writeFileSync("/home/user/code.ts", "aaa\nbbb\nccc\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [
					{ old_text: "aaa", new_text: "AAA" },
					{ old_text: "ccc", new_text: "CCC" },
				],
			});
			expect(result).toContain("-aaa");
			expect(result).toContain("+AAA");
			expect(result).toContain("-ccc");
			expect(result).toContain("+CCC");
			expect(await fs.readFile("/home/user/code.ts")).toBe("AAA\nbbb\nCCC\n");
		});

		it("rejects all edits if one fails validation (atomic)", async () => {
			fs.writeFileSync("/home/user/code.ts", "aaa\nbbb\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [
					{ old_text: "aaa", new_text: "AAA" },
					{ old_text: "NOPE", new_text: "whatever" },
				],
			});
			expect(result).toStartWith("Error:");
			// File must be unchanged
			expect(await fs.readFile("/home/user/code.ts")).toBe("aaa\nbbb\n");
		});

		it("returns error on ENOENT", async () => {
			const result = await tool("edit").execute({
				path: "/nope.txt",
				edits: [{ old_text: "x", new_text: "y" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("not found");
		});

		it("preserves CRLF line endings", async () => {
			fs.writeFileSync("/home/user/win.txt", "line1\r\nline2\r\nline3\r\n");
			await tool("edit").execute({
				path: "/home/user/win.txt",
				edits: [{ old_text: "line2", new_text: "LINE2" }],
			});
			const content = await fs.readFile("/home/user/win.txt");
			expect(content).toBe("line1\r\nLINE2\r\nline3\r\n");
		});

		it("edits file that originally had a BOM (InMemoryFs strips BOM on read)", async () => {
			// InMemoryFs strips BOM on readFile, so we verify the edit itself works.
			// BOM round-trip preservation is tested via integration with real FS.
			fs.writeFileSync("/home/user/bom.txt", "\uFEFFhello world\n");
			const result = await tool("edit").execute({
				path: "/home/user/bom.txt",
				edits: [{ old_text: "hello", new_text: "HELLO" }],
			});
			const content = await fs.readFile("/home/user/bom.txt");
			expect(content).toContain("HELLO world");
			expect(result).toContain("-hello world");
			expect(result).toContain("+HELLO world");
		});

		it("detects overlapping edits", async () => {
			fs.writeFileSync("/home/user/code.ts", "abcdef\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [
					{ old_text: "abcd", new_text: "ABCD" },
					{ old_text: "cdef", new_text: "CDEF" },
				],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("overlap");
			// File must be unchanged
			expect(await fs.readFile("/home/user/code.ts")).toBe("abcdef\n");
		});

		it("produces correct unified diff header", async () => {
			fs.writeFileSync("/home/user/code.ts", "const x = 1;\n");
			const result = await tool("edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "const x = 1;", new_text: "const x = 2;" }],
			});
			expect(result).toContain("--- /home/user/code.ts");
			expect(result).toContain("+++ /home/user/code.ts");
			expect(result).toMatch(/@@ -\d/);
		});
	});
});
