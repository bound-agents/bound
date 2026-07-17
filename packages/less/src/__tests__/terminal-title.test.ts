import { describe, expect, it } from "bun:test";
import {
	RESTORE_TERMINAL_TITLE,
	SAVE_TERMINAL_TITLE,
	TerminalTitleController,
	formatThreadTitleForTerminal,
	sanitizeTerminalTitle,
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
		const controller = new TerminalTitleController(stream, { TERM: "xterm-256color" });

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
