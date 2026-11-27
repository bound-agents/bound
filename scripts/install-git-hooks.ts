/**
 * Root `prepare` hook: point git at the tracked `.githooks/` directory.
 *
 * Idempotent and sandbox-safe. A clone whose `core.hooksPath` already equals
 * `.githooks` is left untouched, so `bun install` never needs to write
 * `.git/config` after the first install. When the write is refused — the
 * boundless shell sandbox keeps `.git/config` read-only on purpose, and git
 * exits 4 ("could not lock config file") — the hook warns and returns
 * success instead of failing the whole install. Outside a git checkout
 * (a tarball or an extracted package) there is nothing to configure.
 */

export const HOOKS_PATH = ".githooks";

export interface GitRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitRunResult;

export type InstallHooksOutcome = "already-set" | "configured" | "not-a-repo" | "write-refused";

export const runGit: GitRunner = (args, cwd) => {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
};

export function installGitHooks(
	cwd: string,
	git: GitRunner = runGit,
	warn: (message: string) => void = (message) => console.warn(message),
): InstallHooksOutcome {
	const inside = git(["rev-parse", "--is-inside-work-tree"], cwd);
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return "not-a-repo";

	// `git config --get` exits 1 when the key is unset; only an exact match skips the write.
	const current = git(["config", "--get", "core.hooksPath"], cwd);
	if (current.exitCode === 0 && current.stdout.trim() === HOOKS_PATH) return "already-set";

	const write = git(["config", "core.hooksPath", HOOKS_PATH], cwd);
	if (write.exitCode === 0) return "configured";

	const detail = write.stderr.trim() || `git config exited ${write.exitCode}`;
	const fix = `git config core.hooksPath ${HOOKS_PATH}`;
	warn(
		`[install-git-hooks] could not set core.hooksPath=${HOOKS_PATH} (${detail}); pre-commit hooks are not installed in this checkout. Run \`${fix}\` outside the sandbox to install them.`,
	);
	return "write-refused";
}

if (import.meta.main) {
	installGitHooks(process.cwd());
}
