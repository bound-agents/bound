import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { TextInput } from "../tui/components/TextInput";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Minimal harness: just a TextInput that displays submitted value.
 */
function TestHarness({ disabled = false }: { disabled?: boolean }) {
	const [submitted, setSubmitted] = useState<string | null>(null);

	return React.createElement(
		React.Fragment,
		null,
		React.createElement(TextInput, {
			onSubmit: (val: string) => setSubmitted(val),
			placeholder: "type here",
			disabled,
		}),
		submitted !== null ? React.createElement(Text, null, `submitted:${submitted}`) : null,
	);
}

describe("TextInput", () => {
	it("basic sanity: renders placeholder when empty", () => {
		const { lastFrame } = render(React.createElement(TestHarness));
		const frame = lastFrame();
		expect(frame).toContain("type here");
	});

	it("accepts typed characters", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("h");
		stdin.write("i");
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("hi");
	});

	it("does not append character when ctrl key is held (Ctrl-C)", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("ab");
		await tick();

		let frame = lastFrame();
		expect(frame).toContain("ab");

		// Ctrl-C sends \x03
		stdin.write("\x03");
		await tick();

		frame = lastFrame();
		// Must NOT contain "abc" — ctrl-c should not add "c"
		expect(frame).not.toContain("abc");
		expect(frame).toContain("ab");
	});

	it("does not append characters for any ctrl combo", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("x");
		await tick();

		// Ctrl-A=\x01, Ctrl-D=\x04, Ctrl-E=\x05
		stdin.write("\x01");
		stdin.write("\x04");
		stdin.write("\x05");
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("x");
		// Should not have appended any of a, d, e
		expect(frame).not.toContain("xa");
	});

	it("handles backspace (DEL 0x7F)", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("abc");
		await tick();

		let frame = lastFrame();
		expect(frame).toContain("abc");

		stdin.write("\x7F");
		await tick();

		frame = lastFrame();
		expect(frame).toContain("ab");
		expect(frame).not.toContain("abc");
	});

	it("handles backspace (BS 0x08)", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("xyz");
		await tick();

		let frame = lastFrame();
		expect(frame).toContain("xyz");

		stdin.write("\x08");
		await tick();

		frame = lastFrame();
		expect(frame).toContain("xy");
		expect(frame).not.toContain("xyz");
	});

	it("handles multiple backspaces", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("abc");
		await tick();
		stdin.write("\x7F");
		stdin.write("\x7F");
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("a");
		expect(frame).not.toContain("ab");
	});

	it("backspace on empty input does not crash", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("\x7F");
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("type here");
	});

	it("clears input after submit", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("hello");
		await tick();
		stdin.write("\r");
		await tick();

		const frame = lastFrame();
		expect(frame).toContain("submitted:hello");
		// Input should be cleared — placeholder shows again
		expect(frame).toContain("type here");
	});

	// --- Cursor navigation ---

	// Escape sequences (what Ink's parseKeypress expects on raw stdin):
	const LEFT = "\x1b[D";
	const RIGHT = "\x1b[C";
	const UP = "\x1b[A";
	const DOWN = "\x1b[B";
	// Option+Left / Option+Right on macOS iTerm / Terminal.app send
	// ESC ESC [ D / ESC ESC [ C, which Ink parses as meta + arrow.
	const OPT_LEFT = "\x1b\x1b[D";
	const OPT_RIGHT = "\x1b\x1b[C";

	it("left arrow moves the cursor back, typing inserts at cursor", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("ac");
		await tick();
		// Cursor is at end — move left once, then type 'b' → should become "abc"
		stdin.write(LEFT);
		await tick();
		stdin.write("b");
		await tick();
		// Submit to observe final value via the harness.
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:abc");
	});

	it("right arrow moves the cursor forward", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("abc");
		await tick();
		// Move cursor two left (between 'a' and 'b'), then one right (between 'b' and 'c'),
		// then insert 'X' → "abXc"
		stdin.write(LEFT);
		stdin.write(LEFT);
		stdin.write(RIGHT);
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:abXc");
	});

	it("left arrow does not go past start", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("ab");
		await tick();
		// Smash left more times than length
		for (let i = 0; i < 10; i++) {
			stdin.write(LEFT);
		}
		await tick();
		// Insert at current pos (should be 0) → "Xab"
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:Xab");
	});

	it("right arrow does not go past end", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("ab");
		await tick();
		// Already at end — smashing right should be a no-op
		for (let i = 0; i < 10; i++) {
			stdin.write(RIGHT);
		}
		await tick();
		stdin.write("Z");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:abZ");
	});

	it("backspace deletes the char before the cursor, not always the last", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("abc");
		await tick();
		// Move cursor to between 'a' and 'b', then backspace → "bc"
		stdin.write(LEFT);
		stdin.write(LEFT);
		await tick();
		stdin.write("\x7F");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:bc");
	});

	it("up/down arrows are swallowed (no stray characters inserted)", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("hi");
		await tick();
		stdin.write(UP);
		stdin.write(DOWN);
		await tick();
		stdin.write("\r");
		await tick();

		// Exactly "hi", no escape sequence bytes leaked in.
		expect(lastFrame()).toContain("submitted:hi");
	});

	it("Option+Left jumps back a word", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("foo bar baz");
		await tick();
		// Cursor at end (pos=11). Option+Left once → start of "baz" (pos=8).
		stdin.write(OPT_LEFT);
		await tick();
		// Insert at pos=8 → "foo bar Xbaz"
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:foo bar Xbaz");
	});

	it("Option+Left twice jumps back two words", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("foo bar baz");
		await tick();
		stdin.write(OPT_LEFT);
		stdin.write(OPT_LEFT);
		await tick();
		// Cursor should be at start of "bar" (pos=4).
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:foo Xbar baz");
	});

	it("Option+Right jumps forward a word", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("foo bar baz");
		await tick();
		// Move cursor to start.
		for (let i = 0; i < 11; i++) {
			stdin.write(LEFT);
		}
		await tick();
		// Option+Right once → past "foo" (pos=3).
		stdin.write(OPT_RIGHT);
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:fooX bar baz");
	});

	it("Option+Left does not go past start", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("foo bar");
		await tick();
		// Option+Left five times — only two words, should clamp at 0.
		for (let i = 0; i < 5; i++) {
			stdin.write(OPT_LEFT);
		}
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:Xfoo bar");
	});
});
