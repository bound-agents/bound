import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopyTool } from "../tools/copy";
import { createEditTool } from "../tools/edit";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import { createWriteTool } from "../tools/write";

/**
 * End-to-end coverage that the in-process write guard actually fires through
 * the real file tools (write/edit/copy) when the sandbox is enabled, and stays
 * out of the way when it's disabled. Pure fs + path — no `@microsoft/mxc-sdk`,
 * no native binary — so this runs identically on every CI runner regardless of
 * whether mxc can contain on the platform. That's the point: these TS tools
 * never pass through the kernel guard, so their containment must hold even
 * where the kernel guard can't run.
 *
 * `cwd` is a tmpdir subdir, which is itself in the writable set, so the denied
 * cases target `/etc/...` — genuinely outside both cwd and tmpdir on the
 * Linux/macOS CI matrix. The guard returns BEFORE touching fs, so nothing is
 * created on disk for a denied write.
 */
const ENABLED: ResolvedSandboxConfig = {
	enabled: true,
	writablePaths: [],
	network: "open",
	onUnavailable: "passthrough",
};
const DISABLED: ResolvedSandboxConfig = {
	enabled: false,
	writablePaths: [],
	network: "open",
	onUnavailable: "passthrough",
};

const DENIED_ABS = "/etc/bound-sandbox-guard-should-never-write.txt";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

describe("write guard through the real file tools", () => {
	let cwd: string;
	const signal = new AbortController().signal;

	beforeEach(() => {
		cwd = join(tmpdir(), `fileguard-${randomBytes(4).toString("hex")}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		// Defensive: ensure no denied write ever escaped onto disk.
		expect(existsSync(DENIED_ABS)).toBe(false);
	});

	describe("boundless_write", () => {
		it("allows a write inside cwd when enabled", async () => {
			const tool = createWriteTool("test", ENABLED);
			const result = await tool({ file_path: "nested/ok.txt", content: "hi" }, signal, cwd);
			expect(result.isError).toBeUndefined();
			expect(existsSync(join(cwd, "nested/ok.txt"))).toBe(true);
		});

		it("denies a write outside the writable set when enabled, with a rich error", async () => {
			const tool = createWriteTool("test", ENABLED);
			const result = await tool({ file_path: DENIED_ABS, content: "leak" }, signal, cwd);
			expect(result.isError).toBe(true);
			const msg = textOf(result);
			expect(msg).toContain("boundless_write refused");
			expect(msg).toContain("sandbox.writablePaths");
			// No file and no parent dir was created — the guard returns before fs.
			expect(existsSync(DENIED_ABS)).toBe(false);
		});

		it("does not enforce when the sandbox is disabled", async () => {
			// Write to a fresh tmp path OUTSIDE cwd; with the guard off it succeeds.
			const outside = join(tmpdir(), `disabled-${randomBytes(4).toString("hex")}.txt`);
			try {
				const tool = createWriteTool("test", DISABLED);
				const result = await tool({ file_path: outside, content: "ok" }, signal, cwd);
				expect(result.isError).toBeUndefined();
				expect(existsSync(outside)).toBe(true);
			} finally {
				rmSync(outside, { force: true });
			}
		});
	});

	describe("boundless_edit", () => {
		it("allows editing a file inside cwd when enabled", async () => {
			const target = join(cwd, "edit-me.txt");
			writeFileSync(target, "alpha beta");
			const tool = createEditTool("test", ENABLED);
			const result = await tool(
				{ file_path: "edit-me.txt", old_string: "alpha", new_string: "gamma" },
				signal,
				cwd,
			);
			expect(result.isError).toBeUndefined();
			expect(readFileSync(target, "utf-8")).toBe("gamma beta");
		});

		it("denies editing a file outside the writable set when enabled", async () => {
			const tool = createEditTool("test", ENABLED);
			const result = await tool(
				{ file_path: "/etc/hosts", old_string: "localhost", new_string: "pwned" },
				signal,
				cwd,
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("boundless_edit refused");
		});
	});

	describe("boundless_copy (host target)", () => {
		it("allows a host->host copy into cwd when enabled", async () => {
			const src = join(cwd, "src.bin");
			writeFileSync(src, "payload");
			const tool = createCopyTool({
				hostname: "test",
				boundUrl: "http://localhost:0",
				sandbox: ENABLED,
			});
			const result = await tool(
				{ source: "host", source_path: src, target: "host", target_path: "copied.bin" },
				signal,
				cwd,
			);
			expect(result.isError).toBeUndefined();
			expect(existsSync(join(cwd, "copied.bin"))).toBe(true);
		});

		it("denies a host target outside the writable set when enabled", async () => {
			const src = join(cwd, "src.bin");
			writeFileSync(src, "payload");
			const tool = createCopyTool({
				hostname: "test",
				boundUrl: "http://localhost:0",
				sandbox: ENABLED,
			});
			const result = await tool(
				{ source: "host", source_path: src, target: "host", target_path: DENIED_ABS },
				signal,
				cwd,
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("boundless_copy refused");
			expect(existsSync(DENIED_ABS)).toBe(false);
		});
	});
});
