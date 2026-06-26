#!/usr/bin/env bun
/**
 * Validates that the `just-bash` UTF-8 command-substitution patch is applied.
 *
 * Context (bound-agents/bound#33, #178): just-bash's `cat` builtin reads files
 * as a latin1 "binary string" and tags its result `stdoutEncoding: "binary"`
 * so byte-faithful redirects (`cat img > copy`) work. Command substitution and
 * script-output aggregation drop that tag, so `--body "$(cat file.md)"` fed the
 * raw UTF-8 octets onward as a plain string, which were then re-encoded as
 * UTF-8 — turning an em dash (U+2014, `E2 80 94`) into `c3 a2 c2 80 c2 94`
 * (rendered as `â`). `patches/just-bash@2.14.4.patch` makes `cat` decode its
 * output to a real UTF-8 string when the bytes are valid UTF-8, and keep the
 * binary string + tag only for genuinely-binary content.
 *
 * The patch is wired through `patchedDependencies` in package.json, keyed to a
 * specific just-bash version. Two things can silently un-apply it:
 *   1. A just-bash version bump: the `just-bash@2.14.4` key no longer matches
 *      the resolved version, so the patch is skipped without a hard error.
 *   2. A broken/partial install where the patched bytes never landed.
 *
 * This script catches both, statically (no agent loop, no sandbox runtime):
 *   - Behavioral assertion: run `$(cat FILE)` with non-ASCII content through a
 *     bare just-bash and confirm the bytes round-trip. This tests the actual
 *     behavior, so it survives chunk-filename changes and internal refactors.
 *   - Version guard: confirm the resolved just-bash version matches the version
 *     the patch was cut against, so a bump fails loudly with a clear message.
 *
 * Run: bun run scripts/validate-just-bash-patch.ts
 * Wired into: bun check (pre-commit / CI gate)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Bash, InMemoryFs, defineCommand } from "just-bash";

/** The just-bash version the patch in patches/ was generated against. */
const PATCHED_VERSION = "2.14.4";

/**
 * A sample containing characters whose UTF-8 encodings begin with bytes that a
 * latin1 mis-decode corrupts: em dash (U+2014), check mark (U+2713), and CJK.
 */
const SAMPLE = "em—dash ✓ 日本語 🚀";

function resolveJustBashVersion(): string | null {
	try {
		const entry = Bun.resolveSync("just-bash", process.cwd());
		// entry = .../just-bash/dist/bundle/index.js → walk up to package.json
		let dir = dirname(entry);
		for (let i = 0; i < 6; i++) {
			try {
				const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
				if (pkg.name === "just-bash") return pkg.version as string;
			} catch {
				// not the package root yet; keep walking up
			}
			dir = dirname(dir);
		}
	} catch {
		return null;
	}
	return null;
}

async function commandSubstitutionPreservesUtf8(): Promise<{ ok: boolean; captured: string }> {
	let captured = "";
	const probe = defineCommand("probe", async (argv: string[]) => {
		captured = argv[0] ?? "";
		return { stdout: "", stderr: "", exitCode: 0 };
	});
	// InMemoryFs forces just-bash's builtin `cat` (no host /usr/bin/cat), matching
	// the production sandbox which backs file tools with the VFS.
	const bash = new Bash({ customCommands: [probe], fs: new InMemoryFs() });
	await bash.exec(`printf '%s' ${JSON.stringify(SAMPLE)} > /tmp/probe.txt`);
	await bash.exec('probe "$(cat /tmp/probe.txt)"');
	return { ok: captured === SAMPLE, captured };
}

function hex(s: string): string {
	return Buffer.from(s, "utf8").toString("hex");
}

async function main(): Promise<void> {
	const resolvedVersion = resolveJustBashVersion();

	const { ok, captured } = await commandSubstitutionPreservesUtf8();

	if (ok) {
		console.log(
			`just-bash UTF-8 substitution patch: applied (just-bash@${resolvedVersion ?? "?"})`,
		);
		process.exit(0);
	}

	console.error("just-bash UTF-8 substitution patch: NOT applied\n");
	console.error("  `$(cat FILE)` corrupted non-ASCII bytes (bound-agents/bound#33, #178):");
	console.error(`    expected: ${JSON.stringify(SAMPLE)}  hex=${hex(SAMPLE)}`);
	console.error(`    actual:   ${JSON.stringify(captured)}  hex=${hex(captured)}`);
	console.error("");

	if (resolvedVersion && resolvedVersion !== PATCHED_VERSION) {
		console.error(
			`  Cause: just-bash resolved to ${resolvedVersion}, but the patch was cut against ${PATCHED_VERSION}.
  A version bump silently skips a patchedDependencies entry.
  Fix: re-cut the patch for ${resolvedVersion}:
    bun patch just-bash
    # re-apply the cat UTF-8 fix in dist/bundle/chunks/<cat-chunk>.js
    bun patch --commit node_modules/just-bash
    # then update PATCHED_VERSION in this script.`,
		);
	} else {
		console.error(
			`  Cause: the patch did not land (broken/partial install).
  Fix: re-run \`bun install\` so patchedDependencies re-applies patches/just-bash@${PATCHED_VERSION}.patch.`,
		);
	}
	process.exit(1);
}

main();
