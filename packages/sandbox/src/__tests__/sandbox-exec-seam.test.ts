import { describe, expect, test } from "bun:test";
import { InMemoryFs, MountableFs } from "just-bash";

import { createSandbox } from "../sandbox-factory";

/**
 * #319: createSandbox is the only exec seam. just-bash's default script
 * normalization `trimStart()`s every non-heredoc line without tracking quotes
 * (#308), so the sandbox's `bash.exec` must reach the interpreter byte-for-byte
 * for every caller, with or without options, including nested `bash -c`.
 */
const SCRIPT = [
	"printf '%s\\n' 'for x in [1]:",
	"    print(x)",
	"\ttabbed'",
	"printf '%s\\n' \"  two spaces",
	'\t\ttwo tabs"',
	"cat <<EOF",
	"  heredoc indented",
	"\theredoc tab",
	"EOF",
	"X='  lit  '; echo \"[$X]\"",
	"if true; then",
	"    echo inside-block",
	"fi",
].join("\n");

const EXPECTED = [
	"for x in [1]:",
	"    print(x)",
	"\ttabbed",
	"  two spaces",
	"\t\ttwo tabs",
	"  heredoc indented",
	"\theredoc tab",
	"[  lit  ]",
	"inside-block",
	"",
].join("\n");

async function makeSandbox() {
	const fs = new MountableFs({ base: new InMemoryFs() });
	await fs.mkdir("/work/sub", { recursive: true });
	return createSandbox({ clusterFs: fs, commands: [] });
}

describe("createSandbox exec seam (#319)", () => {
	test("exec with no options preserves quoted whitespace, heredocs, and literals", async () => {
		const sandbox = await makeSandbox();
		const result = await sandbox.bash.exec(SCRIPT);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(EXPECTED);
	});

	test("cwd still takes effect alongside preserved whitespace", async () => {
		const sandbox = await makeSandbox();
		const result = await sandbox.bash.exec(`${SCRIPT}\npwd`, { cwd: "/work/sub" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${EXPECTED}/work/sub\n`);
	});

	test("an aborted signal still stops execution", async () => {
		const sandbox = await makeSandbox();
		const controller = new AbortController();
		controller.abort();
		const result = await sandbox.bash.exec(`${SCRIPT}\necho after-abort`, {
			signal: controller.signal,
		});
		expect(result.stdout).not.toContain("after-abort");
		expect(result.stdout).not.toContain("inside-block");
	});

	test("nested bash -c keeps a quoted multiline body intact", async () => {
		const sandbox = await makeSandbox();
		const nested = ['bash -c \'printf "%s\\n" "def f():', "    return 1", "\tdone\"'"].join("\n");
		const result = await sandbox.bash.exec(nested);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("def f():\n    return 1\n\tdone\n");
	});
});
