import { existsSync } from "node:fs";

/**
 * Extract the final path segment, splitting on both POSIX (`/`) and Windows
 * (`\`) separators. `node:path`'s `basename` is platform-specific (POSIX-only
 * on non-Windows hosts), so it cannot classify a Windows shell path when
 * boundless itself runs on macOS/Linux. This handles both regardless of host.
 */
function shellBasename(shellPath: string): string {
	const segments = shellPath.split(/[/\\]/);
	return segments[segments.length - 1] ?? shellPath;
}

/**
 * A resolved shell for the boundless `bash`-family tool. The shell determines
 * both the subprocess invocation (`command` + `execFlag`) and the LLM-facing
 * tool identity (`toolName` + `label`). The tool name varies with the shell so
 * that smaller models are not confused by a name/semantics mismatch — e.g. a
 * PowerShell session surfaces `boundless_pwsh`, not `boundless_bash`.
 */
export interface ResolvedShell {
	/** Executable to spawn (bare name resolved on PATH, or an absolute path). */
	command: string;
	/** Flag that introduces the command string: `-c`, `/c`, or `-Command`. */
	execFlag: string;
	/** LLM-facing tool name: `boundless_bash` | `boundless_cmd` | `boundless_pwsh`. */
	toolName: string;
	/** Human-readable shell description for the tool's `description` field. */
	label: string;
}

/** Injectable dependencies so platform/PATH behavior is testable off-Windows. */
export interface ShellResolverDeps {
	/** Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** Resolves a bare command name on PATH; defaults to `Bun.which`. */
	which?: (command: string) => string | null;
	/** Checks whether a path exists; defaults to `node:fs` `existsSync`. */
	exists?: (path: string) => boolean;
	/** Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Classify a shell executable (path or bare name) into a {@link ResolvedShell}.
 * The family is derived from the basename, lowercased and with a trailing
 * `.exe` stripped:
 *   - `cmd`                  → `/c`,       `boundless_cmd`
 *   - `powershell` | `pwsh`  → `-Command`, `boundless_pwsh`
 *   - everything else        → `-c`,       `boundless_bash` (POSIX `-c` semantics)
 *
 * POSIX variants (sh/bash/zsh/dash/fish/…) share `boundless_bash` because they
 * share the `<shell> -c "<command>"` invocation contract and POSIX-style command
 * strings; the genuinely different shells (cmd, PowerShell) get distinct names.
 */
function classifyShell(shellPath: string): ResolvedShell {
	const base = shellBasename(shellPath)
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (base === "cmd") {
		return {
			command: shellPath,
			execFlag: "/c",
			toolName: "boundless_cmd",
			label: "Windows Command Prompt (cmd.exe)",
		};
	}
	if (base === "powershell" || base === "pwsh") {
		return {
			command: shellPath,
			execFlag: "-Command",
			toolName: "boundless_pwsh",
			label: "PowerShell",
		};
	}
	return {
		command: shellPath,
		execFlag: "-c",
		toolName: "boundless_bash",
		label: `POSIX shell (${base})`,
	};
}

/**
 * Resolve a shell executable on the host: a path (containing a separator) is
 * checked for existence directly; a bare name is resolved on PATH. Returns the
 * resolved reference (the original string) or `null` if not found.
 */
function resolveExecutable(
	shell: string,
	which: (command: string) => string | null,
	exists: (path: string) => boolean,
): string | null {
	if (shell.includes("/") || shell.includes("\\")) {
		return exists(shell) ? shell : null;
	}
	return which(shell) ? shell : null;
}

/**
 * Resolve the shell for the boundless bash-family tool.
 *
 * With an explicit `override` (from `config.json`'s `shell` field), the shell is
 * validated for existence and a missing shell throws — a fatal error at attach
 * time, surfaced to the operator rather than silently falling back.
 *
 * With no override, the shell is auto-detected:
 *   - non-Windows → POSIX `sh` (preserves historical behavior exactly)
 *   - Windows     → PowerShell if present (pwsh, then legacy powershell.exe),
 *                   else `%COMSPEC%` / `cmd.exe`
 */
export function resolveShell(
	override: string | undefined,
	deps: ShellResolverDeps = {},
): ResolvedShell {
	const platform = deps.platform ?? process.platform;
	const which = deps.which ?? ((c: string) => Bun.which(c));
	const exists = deps.exists ?? existsSync;
	const env = deps.env ?? process.env;

	if (override !== undefined && override !== "") {
		if (!resolveExecutable(override, which, exists)) {
			throw new Error(
				`boundless: configured shell '${override}' was not found on this system. Set a valid shell path or executable name in config.json's "shell" field, or remove it to auto-detect.`,
			);
		}
		return classifyShell(override);
	}

	if (platform === "win32") {
		const pwsh = which("pwsh") ?? which("powershell.exe") ?? which("powershell");
		if (pwsh) {
			return classifyShell(pwsh);
		}
		return classifyShell(env.COMSPEC ?? "cmd.exe");
	}

	return classifyShell("sh");
}
