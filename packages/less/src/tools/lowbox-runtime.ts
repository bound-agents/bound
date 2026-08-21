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
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", (error) =>
			reject(new LowboxUnavailableError(`native helper failed to launch: ${error.message}`)),
		);
	});
	const control = child.stdio[controlFd] as import("node:stream").Readable | null;
	if (!control) {
		child.kill();
		throw new LowboxUnavailableError("native helper control pipe is unavailable");
	}
	const ready = await new Promise<{ pid: number }>((resolve, reject) => {
		let settled = false;
		let pending = "";
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			callback();
		};
		control.setEncoding("utf8");
		control.on("data", (chunk: string) => {
			pending += chunk;
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			const line = pending.slice(0, newline);
			try {
				const value = JSON.parse(line) as { ok?: boolean; pid?: number };
				if (value.ok === true && typeof value.pid === "number") {
					finish(() => resolve({ pid: value.pid as number }));
				} else {
					const failure = parseLowboxFailure(line);
					finish(() =>
						reject(
							new LowboxUnavailableError(
								failure
									? `${failure.code} (${failure.operation}): ${failure.message}`
									: `invalid native helper response: ${line}`,
							),
						),
					);
				}
			} catch {
				finish(() => reject(new LowboxUnavailableError(`invalid native helper response: ${line}`)));
			}
		});
		child.once("error", (error) =>
			finish(() => reject(new LowboxUnavailableError(`native helper failed: ${error.message}`))),
		);
		child.once("exit", (code) =>
			finish(() =>
				reject(new LowboxUnavailableError(`native helper exited before readiness (${code ?? -1})`)),
			),
		);
	});
	const toWeb = (stream: NodeJS.ReadableStream | null): ReadableStream<Uint8Array> | null =>
		stream ? (Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>) : null;
	return {
		stdout: toWeb(child.stdout),
		stderr: toWeb(child.stderr),
		exited: new Promise<number>((resolve) => {
			child.once("close", (code) => resolve(code ?? -1));
		}),
		pid: ready.pid,
		kill: () => child.kill(),
	};
}
