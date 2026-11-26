/**
 * Synchronous `bwrap --version` runner for the compiled boundless.
 *
 * mxc's Linux availability check (`_probeBubblewrap` in the SDK's
 * `dist/v1/platform.js`) runs `bwrap --version` through an eval'd worker
 * thread that `import()`s `dist/bwrap-probe-worker.js` from the SDK package on
 * disk, which then re-spawns `process.execPath` with two more SDK scripts. In
 * a `bun build --compile` binary none of that works: the package directory
 * does not exist, an eval'd worker cannot import a disk module, and
 * `process.execPath` is the compiled binary rather than a JS runtime. The
 * check fails with "Cannot find module '/dist/bwrap-probe-worker.js'" and the
 * sandbox reports unavailable on every Linux host.
 *
 * `patchMxcBwrapProbePlugin` in `scripts/build.ts` makes the SDK's default
 * runner defer to `globalThis.__boundBwrapVersionRunner` when it is set, and
 * `installBwrapVersionRunner()` sets it to this function. Results use the
 * SDK's runner contract, so its version parsing and minimum-version gate apply
 * unchanged. The time bound the worker existed for is kept by `spawnSync`'s
 * `timeout`.
 */
import { spawnSync } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, sep } from "node:path";

/** The SDK's `BwrapVersionResult` shape (`_mapBwrapHelperResult` output). */
export type BwrapVersionResult =
	| { kind: "notFound" }
	| { kind: "failed"; status: number | null; detail: string }
	| { kind: "output"; path: string; stdout: string };

/** Mirrors the SDK's `BWRAP_FALLBACK_DIRECTORIES`, searched after PATH. */
const BWRAP_FALLBACK_DIRECTORIES: readonly string[] = [
	"/usr/local/sbin",
	"/usr/local/bin",
	"/usr/sbin",
	"/usr/bin",
	"/sbin",
	"/bin",
];

const BWRAP_VERSION_TIMEOUT_MS = 5000;
const BWRAP_VERSION_MAX_BUFFER_BYTES = 64 * 1024;

export interface BwrapVersionOptions {
	/** Defaults to `process.env.PATH`. */
	path?: string;
	/** Defaults to {@link BWRAP_FALLBACK_DIRECTORIES}. */
	fallbackDirectories?: readonly string[];
	timeoutMs?: number;
}

/** Absolute PATH entries then the fallbacks, deduplicated, in order. */
function searchDirectories(opts: BwrapVersionOptions): string[] {
	const dirs: string[] = [];
	const pathEntries = (opts.path ?? process.env.PATH ?? "").split(delimiter);
	for (const dir of [...pathEntries, ...(opts.fallbackDirectories ?? BWRAP_FALLBACK_DIRECTORIES)]) {
		// Relative entries resolve against cwd, which bwrap must never come from.
		if (isAbsolute(dir) && !dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}

type Found = { kind: "found"; path: string } | { kind: "notExecutable"; path: string };

function findBwrap(opts: BwrapVersionOptions): Found | undefined {
	let notExecutable: string | undefined;
	for (const dir of searchDirectories(opts)) {
		const candidate = `${dir}${dir.endsWith(sep) ? "" : sep}bwrap`;
		try {
			if (!statSync(candidate).isFile()) continue;
		} catch {
			continue;
		}
		try {
			accessSync(candidate, constants.X_OK);
			return { kind: "found", path: candidate };
		} catch {
			notExecutable ??= candidate;
		}
	}
	return notExecutable === undefined ? undefined : { kind: "notExecutable", path: notExecutable };
}

export function runBwrapVersion(opts: BwrapVersionOptions = {}): BwrapVersionResult {
	const found = findBwrap(opts);
	if (!found) return { kind: "notFound" };
	if (found.kind === "notExecutable") {
		return {
			kind: "failed",
			status: null,
			detail: `\`bwrap\` was found at ${found.path} but is not executable`,
		};
	}
	const timeoutMs = opts.timeoutMs ?? BWRAP_VERSION_TIMEOUT_MS;
	const result = spawnSync(found.path, ["--version"], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: BWRAP_VERSION_MAX_BUFFER_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		const err = result.error as NodeJS.ErrnoException;
		const detail =
			err.code === "ETIMEDOUT"
				? `timed out after ${timeoutMs}ms`
				: err.code === "ENOBUFS"
					? `probe output exceeded the ${BWRAP_VERSION_MAX_BUFFER_BYTES}-byte cap`
					: err.message;
		return { kind: "failed", status: null, detail };
	}
	if (result.status !== 0) {
		return {
			kind: "failed",
			status: result.status,
			detail: (result.stderr ?? "").trim() || (result.signal ? `signal ${result.signal}` : ""),
		};
	}
	return { kind: "output", path: found.path, stdout: result.stdout ?? "" };
}

/** Global hook the build-time SDK patch consults. */
const HOOK = "__boundBwrapVersionRunner";

/**
 * Point the patched SDK at {@link runBwrapVersion}. Idempotent. Harmless in a
 * source run: the unpatched SDK never reads the hook.
 */
export function installBwrapVersionRunner(): void {
	(globalThis as Record<string, unknown>)[HOOK] = () => runBwrapVersion();
}
