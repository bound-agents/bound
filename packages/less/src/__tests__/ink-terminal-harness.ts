import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type React from "react";

/**
 * A resizable fake terminal for Ink layout tests. Unlike ink-testing-library
 * (fixed 100 columns, no rows, always `debug: true`), this exposes writable
 * `rows`/`columns` and can run Ink in its real (non-debug) mode so tests can
 * inspect the escape sequences Ink emits: the `\x1b[2J` full-terminal clear
 * Ink falls back to when output height reaches `stdout.rows`, and the
 * log-update erase lines that remove a view when it closes.
 */
class FakeStdout extends EventEmitter {
	isTTY = true;
	writes: string[] = [];
	constructor(
		public rows: number,
		public columns: number,
	) {
		super();
	}
	write = (data: string) => {
		this.writes.push(data);
		return true;
	};
	lastFrame = () => this.writes.at(-1);
	resize(rows: number, columns = this.columns) {
		this.rows = rows;
		this.columns = columns;
		this.emit("resize");
	}
}

class FakeStdin extends EventEmitter {
	isTTY = true;
	private data: string | null = null;
	write = (data: string) => {
		this.data = data;
		this.emit("readable");
		this.emit("data", data);
	};
	read = () => {
		const { data } = this;
		this.data = null;
		return data;
	};
	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
}

export function mountTerminal(
	tree: React.ReactElement,
	opts: { rows: number; columns: number; debug: boolean },
) {
	const stdout = new FakeStdout(opts.rows, opts.columns);
	const stdin = new FakeStdin();
	const instance = inkRender(tree, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: new FakeStdout(opts.rows, opts.columns) as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: opts.debug,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return { stdout, stdin, unmount: () => instance.unmount() };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");
export const frameLines = (frame: string | undefined) => stripAnsi(frame ?? "").split("\n");
export const visibleWidth = (line: string) => Array.from(line).length;
export const CLEAR_TERMINAL = "\u001B[2J";
export const ERASE_LINE = "\u001B[2K";

/** Mirrors ink's is-in-ci check: in CI, Ink writes no dynamic frames at all. */
export const inkInCi = (() => {
	const env = process.env;
	return (
		env.CI !== "0" &&
		env.CI !== "false" &&
		("CI" in env ||
			"CONTINUOUS_INTEGRATION" in env ||
			Object.keys(env).some((k) => k.startsWith("CI_")))
	);
})();

export const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
