import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitRunner, HOOKS_PATH, installGitHooks, runGit } from "../install-git-hooks";

function scripted(
	responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
) {
	const calls: string[] = [];
	const git: GitRunner = (args) => {
		const key = args.join(" ");
		calls.push(key);
		const r = responses[key] ?? { exitCode: 0 };
		return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};
	return { git, calls };
}

const INSIDE = { "rev-parse --is-inside-work-tree": { exitCode: 0, stdout: "true\n" } };

describe("installGitHooks", () => {
	it("skips the write when core.hooksPath already equals .githooks", () => {
		const { git, calls } = scripted({
			...INSIDE,
			"config --get core.hooksPath": { exitCode: 0, stdout: ".githooks\n" },
		});
		expect(installGitHooks("/repo", git, () => {})).toBe("already-set");
		expect(calls).not.toContain(`config core.hooksPath ${HOOKS_PATH}`);
	});

	it("writes core.hooksPath when it is unset", () => {
		const { git, calls } = scripted({ ...INSIDE, "config --get core.hooksPath": { exitCode: 1 } });
		expect(installGitHooks("/repo", git, () => {})).toBe("configured");
		expect(calls).toContain(`config core.hooksPath ${HOOKS_PATH}`);
	});

	it("overwrites a different core.hooksPath", () => {
		const { git, calls } = scripted({
			...INSIDE,
			"config --get core.hooksPath": { exitCode: 0, stdout: "elsewhere\n" },
		});
		expect(installGitHooks("/repo", git, () => {})).toBe("configured");
		expect(calls).toContain(`config core.hooksPath ${HOOKS_PATH}`);
	});

	it("warns instead of failing when git refuses the write (read-only .git/config)", () => {
		const warnings: string[] = [];
		const { git } = scripted({
			...INSIDE,
			"config --get core.hooksPath": { exitCode: 1 },
			[`config core.hooksPath ${HOOKS_PATH}`]: {
				exitCode: 4,
				stderr: "error: could not lock config file .git/config: Operation not permitted",
			},
		});
		expect(installGitHooks("/repo", git, (m) => warnings.push(m))).toBe("write-refused");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not lock config file");
	});

	it("does nothing outside a git work tree", () => {
		const { git, calls } = scripted({
			"rev-parse --is-inside-work-tree": { exitCode: 128, stderr: "fatal: not a git repository" },
		});
		expect(installGitHooks("/tarball", git, () => {})).toBe("not-a-repo");
		expect(calls).toEqual(["rev-parse --is-inside-work-tree"]);
	});

	it("configures, then no-ops, then survives a read-only .git/config in a real repo", () => {
		const repo = mkdtempSync(join(tmpdir(), "install-git-hooks-"));
		try {
			expect(runGit(["init", "-q"], repo).exitCode).toBe(0);
			expect(installGitHooks(repo, runGit, () => {})).toBe("configured");
			expect(runGit(["config", "--get", "core.hooksPath"], repo).stdout.trim()).toBe(HOOKS_PATH);
			expect(installGitHooks(repo, runGit, () => {})).toBe("already-set");
			if (process.platform !== "win32" && process.getuid?.() !== 0) {
				expect(runGit(["config", "--unset", "core.hooksPath"], repo).exitCode).toBe(0);
				// git writes config via a sibling lock file, so a read-only .git dir is
				// what actually refuses the write (mirrors the sandbox's denial).
				chmodSync(join(repo, ".git"), 0o555);
				try {
					const warnings: string[] = [];
					expect(installGitHooks(repo, runGit, (m) => warnings.push(m))).toBe("write-refused");
					expect(warnings).toHaveLength(1);
				} finally {
					chmodSync(join(repo, ".git"), 0o755);
				}
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
