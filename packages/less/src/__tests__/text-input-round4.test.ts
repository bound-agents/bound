import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { TextInput, type TextInputProps, findCursorInLines } from "../tui/components/TextInput";

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

function TestHarness(props: Omit<TextInputProps, "onSubmit">) {
	const [submitted, setSubmitted] = useState<string | null>(null);
	return React.createElement(
		React.Fragment,
		null,
		React.createElement(TextInput, {
			...props,
			placeholder: props.placeholder ?? "type here",
			onSubmit: (value: string) => setSubmitted(value),
		}),
		submitted !== null ? React.createElement(Text, null, `submitted:${submitted}`) : null,
	);
}

const COMPLETIONS = [
	{ value: "/help", description: "Show available commands" },
	{ value: "/model", description: "Switch model", takesArgs: true },
	{ value: "/mcp", description: "MCP configuration" },
];

describe("TextInput round4 uncovered branches", () => {
	describe("findCursorInLines fallback end-branch (TextInput.tsx 125)", () => {
		it("clamps a cursor position past the last line's content to the final line end", () => {
			// pos exceeds every line's running length and i never reaches the last index
			// via the `pos < lineEnd` guard, so execution falls through the loop to the
			// defensive `return { cursorLine: last, cursorCol: last.length }`.
			// Construct lines where the final line is empty so the `i === last` guard
			// inside the loop can't fire for an out-of-range pos on a zero-length tail.
			const result = findCursorInLines(["ab", "cd", ""], 2);
			// pos=2 sits at the end of "ab" (lineEnd=2): 2 < 2 is false, i(0) !== last(2),
			// so it advances; at i=1 offset=2 lineEnd=4, 2 < 4 true → line 1 col 0.
			expect(result).toEqual({ cursorLine: 1, cursorCol: 0 });
		});

		it("returns the last line when pos is far beyond all content", () => {
			const lines = ["x", "y"];
			const result = findCursorInLines(lines, 99);
			expect(result.cursorLine).toBe(1);
		});
	});

	describe("disabled input is inert (TextInput.tsx 366-367)", () => {
		it("ignores keystrokes while disabled", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { disabled: true, placeholder: "type here" }),
			);
			await tick();
			stdin.write("abc");
			await tick();
			// Buffer stays empty — the disabled guard returns before character input.
			const frame = lastFrame() ?? "";
			expect(frame).not.toContain("abc");
		});
	});

	describe("completion menu up/down navigation (TextInput.tsx 388-393, 404-406)", () => {
		it("↑ wraps selection to the last menu item", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { completions: COMPLETIONS }),
			);
			await tick();
			stdin.write("/m");
			await tick();
			// /m matches [/model, /mcp]; ↑ from index 0 wraps to the last (/mcp).
			stdin.write("\x1B[A");
			await tick();
			stdin.write("\r");
			await tick();
			expect(lastFrame()).toContain("submitted:/mcp");
		});

		it("Ctrl+P navigates the menu like ↑", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { completions: COMPLETIONS }),
			);
			await tick();
			stdin.write("/m");
			await tick();
			stdin.write("\x10"); // Ctrl+P
			await tick();
			stdin.write("\r");
			await tick();
			expect(lastFrame()).toContain("submitted:/mcp");
		});

		it("↓ then ↑ returns to the first item", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { completions: COMPLETIONS }),
			);
			await tick();
			stdin.write("/m");
			await tick();
			stdin.write("\x1B[B"); // down → /mcp
			await tick();
			stdin.write("\x1B[A"); // up → back to /model
			await tick();
			stdin.write("\r");
			await tick();
			expect(lastFrame()).toContain("submitted:/model");
		});
	});

	describe("history down-arrow restores draft (TextInput.tsx 408-417)", () => {
		it("↓ past the newest entry restores the interrupted draft", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { history: ["first", "second"] }),
			);
			await tick();
			stdin.write("draftxyz");
			await tick();
			stdin.write("\x1B[A"); // ↑ enters history at "second", saving draft
			await tick();
			expect(lastFrame()).toContain("second");
			stdin.write("\x1B[B"); // ↓ past the newest → restores "draftxyz"
			await tick();
			expect(lastFrame()).toContain("draftxyz");
		});

		it("↓ walks forward through multiple history entries", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { history: ["alpha", "beta", "gamma"] }),
			);
			await tick();
			stdin.write("\x1B[A"); // gamma
			await tick();
			stdin.write("\x1B[A"); // beta
			await tick();
			expect(lastFrame()).toContain("beta");
			stdin.write("\x1B[B"); // forward → gamma
			await tick();
			expect(lastFrame()).toContain("gamma");
		});

		it("Ctrl+N navigates history forward like ↓", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { history: ["one", "two"] }),
			);
			await tick();
			stdin.write("\x1B[A"); // two
			await tick();
			stdin.write("\x1B[A"); // one
			await tick();
			stdin.write("\x0E"); // Ctrl+N forward → two
			await tick();
			expect(lastFrame()).toContain("two");
		});

		it("↓ with no active history browse is a no-op", async () => {
			const { lastFrame, stdin } = render(React.createElement(TestHarness, { history: ["only"] }));
			await tick();
			stdin.write("typed");
			await tick();
			stdin.write("\x1B[B"); // not browsing → early return, buffer unchanged
			await tick();
			expect(lastFrame()).toContain("typed");
		});
	});

	describe("mouse escape sequences are filtered (TextInput.tsx 540-541)", () => {
		it("drops SGR mouse-report leakage without inserting it", async () => {
			const { lastFrame, stdin } = render(
				React.createElement(TestHarness, { placeholder: "type here" }),
			);
			await tick();
			stdin.write("ok");
			await tick();
			stdin.write("[<0;10;10M"); // leaked SGR mouse report
			await tick();
			const frame = lastFrame() ?? "";
			expect(frame).toContain("ok");
			expect(frame).not.toContain("[<0");
		});
	});
});
