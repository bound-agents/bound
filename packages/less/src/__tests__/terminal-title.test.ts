import { describe, expect, it } from "bun:test";
import {
	CLEAR_TERMINAL_TITLE,
	RESTORE_TERMINAL_TITLE,
	SAVE_TERMINAL_TITLE,
	TerminalTitleController,
	formatThreadTitleForTerminal,
	sanitizeTerminalTitle,
	supportsTitleStack,
} from "../tui/util/terminal-title";

function captureStream() {
	const writes: string[] = [];
	return {
		writes,
		stream: {
			isTTY: true,
			write: (chunk: string) => {
				writes.push(chunk);
			},
		},
	};
}

describe("terminal title helpers", () => {
	it("formats missing and blank thread titles as untitled", () => {
		expect(formatThreadTitleForTerminal(null)).toBe("(untitled)");
		expect(formatThreadTitleForTerminal("  \n\t ")).toBe("(untitled)");
	});

	it("removes control bytes and collapses whitespace from thread titles", () => {
		expect(sanitizeTerminalTitle("hello\x07\x1b]2;bad\x07\nworld")).toBe("hello ]2;bad world");
	});

	it("saves the current title once, writes OSC 0 titles, and restores on exit", () => {
		const { stream, writes } = captureStream();
		const controller = new TerminalTitleController(stream, { TERM: "xterm-256color" }, "linux");

		controller.set("Thread One");
		controller.set("Thread Two");
		controller.restore();

		expect(writes).toEqual([
			SAVE_TERMINAL_TITLE,
			"\x1b]0;Thread One\x07",
			"\x1b]0;Thread Two\x07",
			RESTORE_TERMINAL_TITLE,
		]);
	});

	it("does nothing outside an interactive terminal", () => {
		const writes: string[] = [];
		const controller = new TerminalTitleController(
			{
				isTTY: false,
				write: (chunk: string) => writes.push(chunk),
			},
			{ TERM: "xterm-256color" },
		);

		controller.set("Thread");
		controller.restore();

		expect(writes).toEqual([]);
	});
});

describe("title stack support detection", () => {
	it("treats POSIX terminals as stack-capable", () => {
		expect(supportsTitleStack("linux", { TERM: "xterm-256color" })).toBe(true);
		expect(supportsTitleStack("darwin", { TERM: "xterm-256color" })).toBe(true);
	});

	it("rejects Windows, where CSI 22/23 t are unimplemented", () => {
		expect(supportsTitleStack("win32", { TERM: "xterm-256color" })).toBe(false);
	});

	it("rejects Windows Terminal hosting a WSL session", () => {
		// platform is linux inside WSL, but the emulator swallowing the sequence
		// is still WinTerm.
		expect(supportsTitleStack("linux", { WT_SESSION: "b4b7b4f0-dead-beef" })).toBe(false);
	});
});

describe("terminal title restore without a title stack", () => {
	it("never pushes, and clears the title on restore", () => {
		const { stream, writes } = captureStream();
		const controller = new TerminalTitleController(stream, { TERM: "xterm-256color" }, "win32");

		controller.set("Thread One");
		controller.set("Thread Two");
		controller.restore();

		// No CSI 22;0t — Windows Terminal would swallow it, and a push that can
		// never be popped is what stranded the thread title on the tab (#225).
		expect(writes).toEqual([
			"\x1b]0;Thread One\x07",
			"\x1b]0;Thread Two\x07",
			CLEAR_TERMINAL_TITLE,
		]);
	});

	it("clears the title under Windows Terminal on WSL", () => {
		const { stream, writes } = captureStream();
		const controller = new TerminalTitleController(
			stream,
			{ TERM: "xterm-256color", WT_SESSION: "b4b7b4f0-dead-beef" },
			"linux",
		);

		controller.set("Thread One");
		controller.restore();

		expect(writes).toEqual(["\x1b]0;Thread One\x07", CLEAR_TERMINAL_TITLE]);
	});

	it("restores at most once and stays quiet when no title was ever set", () => {
		const { stream, writes } = captureStream();
		const controller = new TerminalTitleController(stream, { TERM: "xterm-256color" }, "win32");

		// Exit paths in boundless.tsx can each reach restore(); a bare restore with
		// no prior set must not write a stray clear over the operator's title.
		controller.restore();
		expect(writes).toEqual([]);

		controller.set("Thread One");
		controller.restore();
		controller.restore();

		expect(writes).toEqual(["\x1b]0;Thread One\x07", CLEAR_TERMINAL_TITLE]);
	});
});
