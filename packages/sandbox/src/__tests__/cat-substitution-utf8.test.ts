/**
 * Regression test for bound-agents/bound#33 / #178: UTF-8 corruption through
 * `$(cat FILE)` command substitution.
 *
 * Root cause (in the just-bash dependency, fixed via patches/just-bash@2.14.4.patch):
 * the `cat` builtin reads files as a latin1 "binary string" and tags its result
 * `stdoutEncoding: "binary"` so byte-faithful redirects (`cat img > copy`) work.
 * Command substitution and script-output aggregation drop that tag, so the raw
 * UTF-8 octets were treated as a normal JS string and later re-encoded as UTF-8
 * — turning each multibyte character into mojibake (em dash U+2014 `E2 80 94`
 * became `c3 a2 c2 80 c2 94`, rendering as `â`).
 *
 * The patch makes `cat` decode its assembled output to a real UTF-8 string when
 * the bytes are valid UTF-8 (dropping the binary tag), and keep the binary
 * string + tag only for genuinely-binary content. This test pins both halves:
 * text round-trips through `$(cat)`, and binary content stays byte-identical
 * through `cat > copy`.
 *
 * The agent hit this in production: a non-boundless task staged a GitHub comment
 * body to a file, then ran
 *   github-bound add_issue_comment ... --body "$(cat /home/user/comment.md)"
 * and the em dash in the body was corrupted before reaching GitHub.
 */

import { describe, expect, it } from "bun:test";
import { Bash, InMemoryFs, defineCommand } from "just-bash";

/**
 * Build a Bash over an in-memory FS (matching the production sandbox, which
 * backs `cat` with the VFS and therefore uses just-bash's builtin `cat` rather
 * than a host `/usr/bin/cat`). The `capture` command records the exact argument
 * string it receives, so a test can compare bytes end-to-end.
 */
function makeBash(): { bash: Bash; lastArg: () => string } {
	let captured = "";
	const capture = defineCommand("capture", async (argv: string[]) => {
		captured = argv[0] ?? "";
		return { stdout: "", stderr: "", exitCode: 0 };
	});
	const bash = new Bash({ customCommands: [capture], fs: new InMemoryFs() });
	return { bash, lastArg: () => captured };
}

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

const SAMPLES: Record<string, string> = {
	emDash: "before — after",
	checkCross: "ok ✓ no ✗",
	cjk: "日本語のテスト",
	emoji: "deploy 🚀 ✅",
	curlyQuotes: "“smart” ‘quotes’",
	accented: "café résumé naïve",
	mixed: "check ✓ — 日本語 🚀 café “x”",
};

describe("$(cat FILE) preserves UTF-8 (issue #33 / #178)", () => {
	for (const [label, value] of Object.entries(SAMPLES)) {
		it(`round-trips ${label} through command substitution`, async () => {
			const { bash, lastArg } = makeBash();
			await bash.exec(`printf '%s' ${JSON.stringify(value)} > /tmp/body.md`);
			await bash.exec(`capture "$(cat /tmp/body.md)"`);
			expect(hex(lastArg())).toBe(hex(value));
			expect(lastArg()).toBe(value);
		});
	}

	it("round-trips across multiple files (non-fast-path)", async () => {
		const { bash, lastArg } = makeBash();
		const value = SAMPLES.mixed;
		await bash.exec(`printf '%s' ${JSON.stringify(value)} > /tmp/a`);
		await bash.exec(`capture "$(cat /tmp/a /tmp/a)"`);
		expect(lastArg()).toBe(value + value);
	});

	it("reproduces the exact #178 pattern (staged body file)", async () => {
		const { bash, lastArg } = makeBash();
		const body = 'Following up — "compaction" maps well ✓';
		await bash.exec(`printf '%s' ${JSON.stringify(body)} > /home/user/issue-comment.md`);
		// Mirrors the production command: github-bound ... --body "$(cat FILE)"
		await bash.exec(`capture "$(cat /home/user/issue-comment.md)"`);
		expect(lastArg()).toBe(body);
		// The corruption signature must NOT be present.
		expect(lastArg()).not.toContain("â");
	});
});

describe("cat still preserves binary content byte-for-byte", () => {
	it("keeps invalid-UTF-8 bytes intact through cat > copy", async () => {
		const fs = new InMemoryFs();
		const bash = new Bash({ fs });
		// Bytes that are NOT valid UTF-8 (lone 0xff, lone continuation 0x80, NUL).
		await bash.exec(`printf '%b' '\\xff\\xfe\\x80\\x89PNG\\x00\\xc0\\xc1' > /tmp/bin1`);
		await bash.exec("cat /tmp/bin1 > /tmp/bin2");
		const a = await fs.readFile("/tmp/bin1", "binary");
		const b = await fs.readFile("/tmp/bin2", "binary");
		expect(b).toBe(a);
		// Sanity: the PNG magic survived.
		expect(Buffer.from(a, "latin1").toString("hex")).toContain("89504e47");
	});

	it("direct `cat` of a UTF-8 text file emits decoded text", async () => {
		const fs = new InMemoryFs();
		const bash = new Bash({ fs });
		const value = "line — ✓ 日本語";
		await bash.exec(`printf '%s' ${JSON.stringify(value)} > /tmp/t.txt`);
		const result = await bash.exec("cat /tmp/t.txt");
		expect(result.stdout).toBe(value);
	});
});
