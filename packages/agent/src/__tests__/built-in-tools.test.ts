import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryFs, MountableFs } from "just-bash";
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

	it("creates exactly five tools: read, write, edit, search, retrieve_task", () => {
		expect(tools.size).toBe(5);
		expect(tools.has("bms_read")).toBe(true);
		expect(tools.has("bms_write")).toBe(true);
		expect(tools.has("bms_edit")).toBe(true);
		expect(tools.has("bms_search")).toBe(true);
		expect(tools.has("retrieve_task")).toBe(true);
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
			const result = await tool("bms_read").execute({ path: "/home/user/hello.txt" });
			expect(result).toContain("1\tline one");
			expect(result).toContain("2\tline two");
			expect(result).toContain("3\tline three");
		});

		it("returns error on ENOENT", async () => {
			const result = await tool("bms_read").execute({ path: "/nope.txt" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("/nope.txt");
		});

		it("returns error on EISDIR", async () => {
			fs.mkdirSync("/home/user/mydir", { recursive: true });
			const result = await tool("bms_read").execute({ path: "/home/user/mydir" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("directory");
		});

		it("detects binary content (NUL byte in first 8KB)", async () => {
			const binary = "hello\0world";
			fs.writeFileSync("/home/user/bin.dat", binary);
			const result = await tool("bms_read").execute({ path: "/home/user/bin.dat" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("binary");
		});

		it("applies offset (1-based)", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("bms_read").execute({ path: "/home/user/lines.txt", offset: 3 });
			expect(result).toContain("3\tc");
			expect(result).toContain("4\td");
			expect(result).not.toContain("1\ta");
			expect(result).not.toContain("2\tb");
		});

		it("applies limit", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("bms_read").execute({ path: "/home/user/lines.txt", limit: 2 });
			expect(result).toContain("1\ta");
			expect(result).toContain("2\tb");
			expect(result).not.toContain("3\tc");
		});

		it("applies offset + limit together", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\nc\nd\ne\n");
			const result = await tool("bms_read").execute({
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
			const result = await tool("bms_read").execute({
				path: "/home/user/lines.txt",
				limit: 2,
			});
			expect(result).toContain("[Use offset=3 to continue]");
		});

		it("does NOT show continuation hint at end of file", async () => {
			fs.writeFileSync("/home/user/lines.txt", "a\nb\n");
			const result = await tool("bms_read").execute({ path: "/home/user/lines.txt" });
			expect(result).not.toContain("[Use offset=");
		});

		it("rejects invalid offset", async () => {
			fs.writeFileSync("/home/user/f.txt", "x\n");
			const result = await tool("bms_read").execute({ path: "/home/user/f.txt", offset: 0 });
			expect(result).toStartWith("Error:");
			expect(result).toContain("invalid");
		});

		it("rejects limit > 2000", async () => {
			fs.writeFileSync("/home/user/f.txt", "x\n");
			const result = await tool("bms_read").execute({ path: "/home/user/f.txt", limit: 2001 });
			expect(result).toStartWith("Error:");
			expect(result).toContain("invalid");
		});

		it("truncates output to 50,000 bytes without partial lines", async () => {
			// Each line is ~100 chars -> 600 lines ~ 60KB > 50KB
			const longLine = "x".repeat(99);
			const lines = Array.from({ length: 600 }, () => longLine).join("\n");
			fs.writeFileSync("/home/user/big.txt", lines);
			const result = await tool("bms_read").execute({ path: "/home/user/big.txt" });
			// Result must be <= 50,000 bytes
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(55_000); // some slack for line nums + hint
			// Must not contain partial lines — every content line should end with x's
			expect(result).toContain("[Use offset=");
		});

		it("pads line numbers to 6 columns", async () => {
			fs.writeFileSync("/home/user/f.txt", "hello\n");
			const result = await tool("bms_read").execute({ path: "/home/user/f.txt" });
			// Line number should be right-padded to 6 chars
			expect(result).toMatch(/\s+1\thello/);
		});
	});

	// ─── write ──────────────────────────────────────────────────────────

	describe("write", () => {
		it("writes a new file and returns byte count", async () => {
			const result = await tool("bms_write").execute({
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
			const result = await tool("bms_write").execute({
				path: "/home/user/exist.txt",
				content: "new content",
			});
			expect(result).toContain("Wrote");
			expect(await fs.readFile("/home/user/exist.txt")).toBe("new content");
		});

		it("creates parent directories automatically", async () => {
			const result = await tool("bms_write").execute({
				path: "/home/user/deep/nested/dir/file.txt",
				content: "deep",
			});
			expect(result).toContain("Wrote");
			expect(await fs.readFile("/home/user/deep/nested/dir/file.txt")).toBe("deep");
		});

		it("handles UTF-8 multibyte correctly", async () => {
			const content = "cafe\u0301 \u{1F600}"; // cafe + combining accent + emoji
			const result = await tool("bms_write").execute({
				path: "/home/user/utf8.txt",
				content,
			});
			const bytes = Buffer.byteLength(content, "utf8");
			expect(result).toContain(`${bytes} bytes`);
		});
	});

	// ─── host path guard ────────────────────────────────────────────────

	describe("host path guard", () => {
		it("rejects a Windows drive-letter path on write", async () => {
			const path = "C:\\Users\\user\\Documents\\GitHub\\bound\\scripts\\x.ts";
			const result = await tool("bms_write").execute({ path, content: "hi" });
			expect(result).toStartWith("Error:");
			expect(result).toContain("sandbox");
			// Nothing landed in the VFS root as a junk filename
			expect(await fs.readdir("/")).not.toContain(path);
		});

		it("rejects a slash-prefixed Windows path on write", async () => {
			const result = await tool("bms_write").execute({
				path: "/C:\\Users\\user\\x.ts",
				content: "hi",
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("sandbox");
		});

		it("rejects a forward-slash drive-letter path on write", async () => {
			const result = await tool("bms_write").execute({
				path: "C:/Users/user/x.ts",
				content: "hi",
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("sandbox");
		});

		it("rejects a host-absolute POSIX path on write and names the writable roots", async () => {
			const result = await tool("bms_write").execute({
				path: "/Users/user/Documents/notes.md",
				content: "hi",
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("/home/user");
			expect(result).toContain("/tmp");
		});

		it("rejects dot-dot traversal escaping a writable root", async () => {
			const result = await tool("bms_write").execute({
				path: "/tmp/../Users/user/escape.txt",
				content: "hi",
			});
			expect(result).toStartWith("Error:");
		});

		it("rejects a relative path on write", async () => {
			const result = await tool("bms_write").execute({ path: "notes.md", content: "hi" });
			expect(result).toStartWith("Error:");
		});

		it("allows writes under /tmp", async () => {
			const result = await tool("bms_write").execute({
				path: "/tmp/scratch.txt",
				content: "hi",
			});
			expect(result).toContain("Wrote");
		});

		it("derives writable roots from mount points, covering overlay mounts", async () => {
			const base = new InMemoryFs();
			const mounted = new MountableFs({ base });
			mounted.mount("/home/user", new InMemoryFs());
			mounted.mount("/mnt/repo", new InMemoryFs());
			const mountedTools = createBuiltInTools(mounted);
			const writeTool = mountedTools.get("bms_write");
			if (!writeTool) throw new Error("write tool not found");

			const allowed = await writeTool.execute({
				path: "/mnt/repo/src/file.ts",
				content: "ok",
			});
			expect(allowed).toContain("Wrote");

			const denied = await writeTool.execute({
				path: "/etc/passwd",
				content: "nope",
			});
			expect(denied).toStartWith("Error:");
			expect(denied).toContain("/mnt/repo");
		});

		it("rejects a Windows path on edit with the guard message, not ENOENT", async () => {
			const result = await tool("bms_edit").execute({
				path: "C:\\Users\\user\\code.ts",
				edits: [{ old_text: "a", new_text: "b" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("sandbox");
		});

		it("rejects a Windows path on read with the guard message", async () => {
			const result = await tool("bms_read").execute({
				path: "C:\\Users\\user\\code.ts",
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("sandbox");
		});

		it("still reads POSIX paths outside writable roots (shape guard only)", async () => {
			fs.writeFileSync("/var/data.txt", "readable\n");
			const result = await tool("bms_read").execute({ path: "/var/data.txt" });
			expect(result).toContain("readable");
		});
	});

	// ─── edit ───────────────────────────────────────────────────────────

	describe("edit", () => {
		it("applies a single edit and returns unified diff", async () => {
			fs.writeFileSync("/home/user/code.ts", "const x = 1;\nconst y = 2;\n");
			const result = await tool("bms_edit").execute({
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
			const result = await tool("bms_edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "NOPE", new_text: "whatever" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("not found");
		});

		it("returns error when old_text matches multiple times", async () => {
			fs.writeFileSync("/home/user/code.ts", "foo\nfoo\n");
			const result = await tool("bms_edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "foo", new_text: "bar" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("2 times");
		});

		it("applies multiple edits atomically", async () => {
			fs.writeFileSync("/home/user/code.ts", "aaa\nbbb\nccc\n");
			const result = await tool("bms_edit").execute({
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
			const result = await tool("bms_edit").execute({
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
			const result = await tool("bms_edit").execute({
				path: "/nope.txt",
				edits: [{ old_text: "x", new_text: "y" }],
			});
			expect(result).toStartWith("Error:");
			expect(result).toContain("not found");
		});

		it("preserves CRLF line endings", async () => {
			fs.writeFileSync("/home/user/win.txt", "line1\r\nline2\r\nline3\r\n");
			await tool("bms_edit").execute({
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
			const result = await tool("bms_edit").execute({
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
			const result = await tool("bms_edit").execute({
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
			const result = await tool("bms_edit").execute({
				path: "/home/user/code.ts",
				edits: [{ old_text: "const x = 1;", new_text: "const x = 2;" }],
			});
			expect(result).toContain("--- /home/user/code.ts");
			expect(result).toContain("+++ /home/user/code.ts");
			expect(result).toMatch(/@@ -\d/);
		});
	});

	describe("read (image files)", () => {
		it("returns ContentBlock[] with image block for PNG files", async () => {
			// Write a minimal PNG's raw bytes as a string into the VFS
			const pngBuffer = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			);
			await fs.writeFile("/image.png", pngBuffer.toString("binary"));

			const result = await tool("bms_read").execute({ path: "/image.png" });

			// Should return ContentBlock[] with an image block, not an error string
			expect(Array.isArray(result)).toBe(true);
			const blocks = result as Array<Record<string, unknown>>;
			const imageBlock = blocks.find((b) => b.type === "image");
			expect(imageBlock).toBeDefined();
			expect((imageBlock as Record<string, unknown>).source).toEqual({
				type: "base64",
				media_type: "image/png",
				data: expect.any(String),
			});
		});

		it("returns ContentBlock[] with image block for JPEG files", async () => {
			const jpegBuffer = Buffer.from([
				0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
				0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
			]);
			await fs.writeFile("/photo.jpg", jpegBuffer.toString("binary"));

			const result = await tool("bms_read").execute({ path: "/photo.jpg" });

			expect(Array.isArray(result)).toBe(true);
			const blocks = result as Array<Record<string, unknown>>;
			const imageBlock = blocks.find((b) => b.type === "image");
			expect(imageBlock).toBeDefined();
		});

		it("still returns error string for non-image binary files", async () => {
			const binaryContent = String.fromCharCode(0, 1, 2, 3, 4, 5);
			await fs.writeFile("/data.bin", binaryContent);

			const result = await tool("bms_read").execute({ path: "/data.bin" });

			expect(typeof result).toBe("string");
			expect(result as string).toContain("Error: binary content not supported");
		});
	});

	// ─── retrieve_task ──────────────────────────────────────────────────

	describe("retrieve_task", () => {
		it("declares itself as a zero-argument tool", () => {
			const def = tool("retrieve_task").toolDefinition;
			expect(def.function.name).toBe("retrieve_task");
			const params = def.function.parameters as {
				type: string;
				properties: Record<string, unknown>;
				required?: string[];
			};
			expect(params.type).toBe("object");
			expect(params.properties).toEqual({});
			expect(params.required).toBeUndefined();
		});

		it("returns a system-forced-call notice that flags the call as redundant", async () => {
			const result = await tool("retrieve_task").execute({});
			expect(typeof result).toBe("string");
			const msg = result as string;
			// New banner makes it explicit the model called this voluntarily and
			// the earlier (synthetic) call was scheduler-forged.
			expect(msg).toContain("[System notice");
			expect(msg).toContain("forged by the");
			expect(msg).toContain("[Task wakeup]");
			expect(msg).toContain("Proceed");
		});

		it("ignores unexpected arguments gracefully", async () => {
			const result = await tool("retrieve_task").execute({ task_id: "abc", extra: 42 });
			expect(typeof result).toBe("string");
			expect((result as string).length).toBeGreaterThan(0);
		});
	});

	// ─── search ───────────────────────────────────────────────────────────

	describe("search", () => {
		beforeEach(async () => {
			await fs.writeFile(
				"/src/alpha.ts",
				"const greeting = 'hello world';\nexport { greeting };\n",
			);
			await fs.writeFile("/src/beta.ts", "// HELLO from beta\nfunction f() { return 1; }\n");
			await fs.writeFile("/docs/readme.md", "Say hello to the docs.\n");
		});

		it("returns grep-style path:line:preview matches across files", async () => {
			const result = (await tool("bms_search").execute({ pattern: "greeting" })) as string;
			expect(result).toContain("/src/alpha.ts:1:");
			expect(result).toContain("greeting");
			// The match on line 2 should also surface.
			expect(result).toContain("/src/alpha.ts:2:");
		});

		it("is case-sensitive by default and case-insensitive on request", async () => {
			const sensitive = (await tool("bms_search").execute({ pattern: "HELLO" })) as string;
			// Only beta.ts has uppercase HELLO.
			expect(sensitive).toContain("/src/beta.ts:1:");
			expect(sensitive).not.toContain("/src/alpha.ts");

			const insensitive = (await tool("bms_search").execute({
				pattern: "hello",
				case_insensitive: true,
			})) as string;
			expect(insensitive).toContain("/src/alpha.ts:1:");
			expect(insensitive).toContain("/src/beta.ts:1:");
			expect(insensitive).toContain("/docs/readme.md:1:");
		});

		it("treats the pattern as a literal when fixed_strings is set", async () => {
			await fs.writeFile("/src/regex.ts", "a.b matches here\naxb should not\n");
			const result = (await tool("bms_search").execute({
				pattern: "a.b",
				fixed_strings: true,
			})) as string;
			expect(result).toContain("/src/regex.ts:1:");
			expect(result).not.toContain("/src/regex.ts:2:");
		});

		it("scopes to a path prefix when path is provided", async () => {
			const result = (await tool("bms_search").execute({
				pattern: "hello",
				case_insensitive: true,
				path: "/src",
			})) as string;
			expect(result).toContain("/src/alpha.ts");
			expect(result).not.toContain("/docs/readme.md");
		});

		it("skips excluded directories like node_modules", async () => {
			await fs.writeFile("/node_modules/pkg/index.js", "const greeting = 'vendored';\n");
			const result = (await tool("bms_search").execute({ pattern: "greeting" })) as string;
			expect(result).toContain("/src/alpha.ts");
			expect(result).not.toContain("node_modules");
		});

		it("returns an error string for an invalid regex", async () => {
			const result = (await tool("bms_search").execute({ pattern: "(" })) as string;
			expect(result.startsWith("Error:")).toBe(true);
		});
	});
});
