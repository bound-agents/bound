import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSearchTool } from "../tools/search";

describe("boundless_search", () => {
	let tempDir: string;
	const tool = createSearchTool("test-host");

	function run(args: Record<string, unknown>) {
		return tool(args, new AbortController().signal, tempDir);
	}

	/** Concatenate the non-provenance text blocks of a tool result. */
	function body(result: Awaited<ReturnType<typeof tool>>): string {
		return result.content
			.slice(1)
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("\n");
	}

	beforeEach(() => {
		tempDir = join("/tmp", `boundless-search-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(join(tempDir, "src"), { recursive: true });
		mkdirSync(join(tempDir, "docs"), { recursive: true });
		writeFileSync(
			join(tempDir, "src", "alpha.ts"),
			"const greeting = 'hello world';\nexport { greeting };\n",
		);
		writeFileSync(
			join(tempDir, "src", "beta.ts"),
			"// HELLO from beta\nfunction f() { return 1; }\n",
		);
		writeFileSync(join(tempDir, "docs", "readme.md"), "Say hello to the docs.\n");
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("carries a provenance prefix and grep-style matches", async () => {
		const result = await run({ pattern: "greeting" });
		expect(result.isError).toBeUndefined();
		const provenance = result.content[0];
		expect(provenance.type).toBe("text");
		expect(provenance.text).toContain("[boundless]");
		expect(provenance.text).toContain("tool=boundless_search");

		const text = body(result);
		// Paths are reported relative to cwd.
		expect(text).toContain("src/alpha.ts:1:");
		expect(text).toContain("src/alpha.ts:2:");
		expect(text).toContain("greeting");
	});

	it("is case-sensitive by default and case-insensitive on request", async () => {
		const sensitive = body(await run({ pattern: "HELLO" }));
		expect(sensitive).toContain("src/beta.ts:1:");
		expect(sensitive).not.toContain("src/alpha.ts");

		const insensitive = body(await run({ pattern: "hello", case_insensitive: true }));
		expect(insensitive).toContain("src/alpha.ts:1:");
		expect(insensitive).toContain("src/beta.ts:1:");
		expect(insensitive).toContain("docs/readme.md:1:");
	});

	it("treats the pattern as a literal when fixed_strings is set", async () => {
		writeFileSync(join(tempDir, "src", "regex.ts"), "a.b matches here\naxb should not\n");
		const text = body(await run({ pattern: "a.b", fixed_strings: true }));
		expect(text).toContain("src/regex.ts:1:");
		expect(text).not.toContain("src/regex.ts:2:");
	});

	it("scopes to a subdirectory when path is provided", async () => {
		const text = body(await run({ pattern: "hello", case_insensitive: true, path: "src" }));
		expect(text).toContain("src/alpha.ts");
		expect(text).not.toContain("docs/readme.md");
	});

	it("skips excluded directories like node_modules", async () => {
		mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(
			join(tempDir, "node_modules", "pkg", "index.js"),
			"const greeting = 'vendored';\n",
		);
		const text = body(await run({ pattern: "greeting" }));
		expect(text).toContain("src/alpha.ts");
		expect(text).not.toContain("node_modules");
	});

	it("reports a missing pattern as an error", async () => {
		const result = await run({});
		expect(result.isError).toBe(true);
		expect(body(result)).toContain("pattern is required");
	});

	it("reports an invalid regex as an error", async () => {
		const result = await run({ pattern: "(" });
		expect(result.isError).toBe(true);
		expect(body(result).startsWith("Error:")).toBe(true);
	});
});
