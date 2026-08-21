import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ResolvedSandboxConfig, SandboxSpawnResult } from "./sandbox-policy";
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

interface ResolveLowboxHelperOptions {
	platform?: NodeJS.Platform;
	executablePath?: string;
}

export function resolveLowboxHelperPath(options: ResolveLowboxHelperOptions = {}): string {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") throw new LowboxUnavailableError(`unsupported platform ${platform}`);
	const helper =
		process.env.BOUND_LOWBOX_HELPER ||
		join(dirname(options.executablePath ?? process.execPath), "bound-lowbox.exe");
	if (!existsSync(helper)) throw new LowboxUnavailableError(`native helper not found at ${helper}`);
	return helper;
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

export async function spawnLowbox(
	command: string,
	cwd: string,
	policyCwd: string,
	shell: ResolvedShell,
	cfg: ResolvedSandboxConfig,
	testNamespace?: string,
): Promise<SandboxSpawnResult> {
	const helper = resolveLowboxHelperPath();
	const controlFd = 3;
	const child = spawn(
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
