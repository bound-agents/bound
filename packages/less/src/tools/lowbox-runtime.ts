/// <reference path="./lowbox-embedded.d.ts" />
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { LOWBOX_EMBEDDED_HELPER, LOWBOX_HELPER_HASH } from "../_lowbox/embedded";
import {
	type ResolvedSandboxConfig,
	type SandboxSpawnResult,
	computeGitProtectedPaths,
} from "./sandbox-policy";
import type { ResolvedShell } from "./shell";

export class LowboxUnavailableError extends Error {
	readonly code = "LOWBOX_HELPER_UNAVAILABLE";

	constructor(message: string) {
		super(`LOWBOX_HELPER_UNAVAILABLE: ${message}`);
		this.name = "LowboxUnavailableError";
	}
}

export interface LowboxFailure {
	ok: false;
	code: string;
	operation: string;
	win32?: number;
	message: string;
}

export function lowboxHelperSourcePath(): string {
	return join(import.meta.dir, "..", "native", "bound-lowbox.cpp");
}

let helperMaterialized = false;

/**
 * Write the embedded helper bytes (carried into the compiled boundless via
 * `with { type: "file" }`, mirroring the mxc runtime) out to a stable
 * per-content-hash path under `~/.bound/less/lowbox-runtime/` and return it.
 * In a dev / source run the importer is null (non-Windows) or points at the
 * on-disk staged file — either way the caller treats a non-existent result as
 * "not bundled".
 */
export function materializeLowboxHelper(
	hash: string,
	embeddedPath: string,
	baseDir: string = join(homedir(), ".bound", "less", "lowbox-runtime"),
): string {
	const root = join(baseDir, hash);
	const dest = join(root, "bound-lowbox.exe");
	if (!existsSync(dest)) {
		mkdirSync(root, { recursive: true });
		writeFileSync(dest, readFileSync(embeddedPath));
		try {
			chmodSync(dest, 0o755);
		} catch {
			// Best effort; Windows ignores the mode anyway.
		}
	}
	return dest;
}

interface ResolveLowboxHelperOptions {
	platform?: NodeJS.Platform;
	executablePath?: string;
	helperPath?: string;
	/** Consult the helper embedded in this binary (default true). Tests disable it. */
	allowEmbedded?: boolean;
}

export function resolveLowboxHelperPath(options: ResolveLowboxHelperOptions = {}): string {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") throw new LowboxUnavailableError(`unsupported platform ${platform}`);
	const sibling = join(dirname(options.executablePath ?? process.execPath), "bound-lowbox.exe");
	// Resolution order: explicit helperPath/executablePath sibling (tests,
	// operator override of the exe location) → BOUND_LOWBOX_HELPER env (CI
	// oracle contract) → sibling of the running exe (dist layout, dev beside
	// boundless) → helper embedded in this binary and materialized under
	// ~/.bound/less/lowbox-runtime/<hash>/ (standalone compiled boundless).
	const candidates: string[] =
		"helperPath" in options
			? [options.helperPath ?? sibling]
			: [process.env.BOUND_LOWBOX_HELPER, sibling].filter((v): v is string => Boolean(v));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	if ((options.allowEmbedded ?? true) && LOWBOX_EMBEDDED_HELPER) {
		if (!helperMaterialized) {
			helperMaterialized = true;
			const materialized = materializeLowboxHelper(LOWBOX_HELPER_HASH, LOWBOX_EMBEDDED_HELPER.path);
			if (existsSync(materialized)) return materialized;
		}
	}
	throw new LowboxUnavailableError(
		`native helper not found at ${sibling} and no embedded helper is bundled`,
	);
}

export function buildLowboxArgs(
	command: string,
	cwd: string,
	policyCwd: string,
	shell: ResolvedShell,
	cfg: ResolvedSandboxConfig,
	tempRoot: string,
	controlHandle: string,
	testNamespace?: string,
): string[] {
	return [
		"spawn",
		"--control-handle",
		controlHandle,
		"--cwd",
		cwd,
		"--shell",
		shell.command,
		"--shell-flag",
		shell.execFlag,
		"--command",
		command,
		"--network",
		cfg.network,
		...(testNamespace ? ["--test-namespace", testNamespace] : []),
		...[policyCwd, cwd, tempRoot, ...cfg.writablePaths].flatMap((root) => ["--writable", root]),
		...computeGitProtectedPaths(policyCwd, "win32", cfg.gitWorktreeMetadata).flatMap((path) => [
			"--git-protected",
			path,
		]),
	];
}

export function parseLowboxFailure(line: string): LowboxFailure | null {
	try {
		const value = JSON.parse(line) as Partial<LowboxFailure>;
		if (
			value.ok === false &&
			typeof value.code === "string" &&
			typeof value.operation === "string" &&
			typeof value.message === "string"
		) {
			return value as LowboxFailure;
		}
	} catch {
		// Native diagnostics remain ordinary stderr when they are not protocol JSON.
	}
	return null;
}

type SpawnLowboxOptions = {
	spawn?: typeof spawn;
};

export async function spawnLowbox(
	command: string,
	cwd: string,
	policyCwd: string,
	shell: ResolvedShell,
	cfg: ResolvedSandboxConfig,
	testNamespace?: string,
	options: SpawnLowboxOptions = {},
): Promise<SandboxSpawnResult> {
	const helper = resolveLowboxHelperPath();
	const controlFd = 3;
	const child = (options.spawn ?? spawn)(
		helper,
		buildLowboxArgs(
			command,
			cwd,
			policyCwd,
			shell,
			cfg,
			process.env.TEMP ?? cwd,
			String(controlFd),
			testNamespace,
		),
		{
			cwd,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	const spawned = new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", (error) =>
			reject(new LowboxUnavailableError(`native helper failed to launch: ${error.message}`)),
		);
	});
	const exited = new Promise<number>((resolve) => {
		child.once("close", (code) => resolve(code ?? -1));
	});
	await spawned;
	const control = child.stdio[controlFd] as import("node:stream").Readable | null;
	if (!control) {
		child.kill();
		throw new LowboxUnavailableError("native helper control pipe is unavailable");
	}
	let controlPending = "";
	let readySettled = false;
	let resolveReady!: (value: { pid: number }) => void;
	let rejectReady!: (reason: Error) => void;
	const ready = new Promise<{ pid: number }>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const terminalWatcherDiagnostics: string[] = [];
	const reportTerminalWatcherDiagnostic = (line: string) => {
		terminalWatcherDiagnostics.push(line);
		console.error(`[boundless] lowbox watcher: ${line}`);
	};
	const consumeControlLines = () => {
		for (;;) {
			const newline = controlPending.indexOf("\n");
			if (newline < 0) return;
			const line = controlPending.slice(0, newline);
			controlPending = controlPending.slice(newline + 1);
			if (!line) continue;
			if (readySettled) {
				reportTerminalWatcherDiagnostic(line);
				continue;
			}
			try {
				const value = JSON.parse(line) as { ok?: boolean; pid?: number };
				readySettled = true;
				if (value.ok === true && typeof value.pid === "number") {
					resolveReady({ pid: value.pid });
				} else {
					const failure = parseLowboxFailure(line);
					rejectReady(
						new LowboxUnavailableError(
							failure
								? `${failure.code} (${failure.operation}): ${failure.message}`
								: `invalid native helper response: ${line}`,
						),
					);
				}
			} catch {
				readySettled = true;
				rejectReady(new LowboxUnavailableError(`invalid native helper response: ${line}`));
			}
		}
	};
	control.setEncoding("utf8");
	control.on("data", (chunk: string) => {
		controlPending += chunk;
		consumeControlLines();
	});
	control.on("end", () => {
		if (controlPending) {
			if (readySettled) reportTerminalWatcherDiagnostic(controlPending);
			else
				rejectReady(
					new LowboxUnavailableError(`invalid native helper response: ${controlPending}`),
				);
			controlPending = "";
		}
	});
	child.once("error", (error) => {
		if (!readySettled) {
			readySettled = true;
			rejectReady(new LowboxUnavailableError(`native helper failed: ${error.message}`));
		}
	});
	child.once("exit", (code) => {
		if (!readySettled) {
			readySettled = true;
			rejectReady(
				new LowboxUnavailableError(`native helper exited before readiness (${code ?? -1})`),
			);
		}
	});
	const readyResult = await ready;
	const toWeb = (stream: NodeJS.ReadableStream | null): ReadableStream<Uint8Array> | null =>
		stream ? (Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>) : null;
	return {
		stdout: toWeb(child.stdout),
		stderr: toWeb(child.stderr),
		exited,
		pid: readyResult.pid,
		kill: () => child.kill(),
	};
}
