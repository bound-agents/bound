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

	// --- Grapheme cluster navigation ---
	//
	// Emoji, flags, and combining marks are multi-code-unit grapheme
	// clusters. The cursor must treat each cluster as one "character" —
	// Left/Right step over the whole cluster, Backspace deletes the whole
	// cluster, and insertion in the middle of a string with clusters lands
	// at cluster boundaries (not inside surrogate pairs).
	//
	// Quick reference for what's in these tests:
	//   "🐻"       — 1 grapheme, 2 JS code units (surrogate pair)
	//   "🇯🇵"       — 1 grapheme, 4 JS code units (two regional indicators)
	//   "é" (e+́)  — 1 grapheme, 2 JS code units (base + combining acute)

	it("left arrow over an emoji skips the whole cluster, not half a surrogate", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("a🐻c");
		await tick();
		// Cursor at end. Left once should land between 🐻 and c (pos=3).
		// Insert X there → "a🐻Xc".
		stdin.write(LEFT);
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:a🐻Xc");
	});

	it("left arrow twice over an emoji lands before the cluster", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("a🐻c");
		await tick();
		// Left twice: end → between 🐻 and c → between a and 🐻 (pos=1).
		stdin.write(LEFT);
		stdin.write(LEFT);
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:aX🐻c");
	});

	it("backspace removes an entire emoji cluster, not half a surrogate", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("a🐻c");
		await tick();
		// Move cursor to between 🐻 and c (one Left from end).
		stdin.write(LEFT);
		await tick();
		// Backspace: must delete 🐻 entirely, not leave a lone surrogate.
		stdin.write("\x7F");
		await tick();
		stdin.write("\r");
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("submitted:ac");
		// And crucially, no stray "🐻" or broken replacement char.
		expect(frame).not.toContain("🐻");
		expect(frame).not.toContain("\uFFFD");
	});

	it("backspace at end removes the trailing emoji cluster", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("hi🐻");
		await tick();
		stdin.write("\x7F");
		await tick();
		stdin.write("\r");
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("submitted:hi");
		expect(frame).not.toContain("🐻");
	});

	it("navigates a flag emoji (2 regional indicators = 1 cluster)", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("a🇯🇵c");
		await tick();
		// Left once from end → between flag and c. Insert X → "a🇯🇵Xc".
		stdin.write(LEFT);
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:a🇯🇵Xc");
	});

	it("backspace removes a whole flag cluster (both regional indicators)", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("a🇯🇵");
		await tick();
		stdin.write("\x7F");
		await tick();
		stdin.write("\r");
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("submitted:a");
		// Must not leave a lone regional indicator behind.
		expect(frame).not.toContain("🇯");
		expect(frame).not.toContain("🇵");
	});

	it("combining marks are treated as part of the same cluster", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		// "e" + combining acute accent (U+0301) — renders as é.
		const eCombining = "e\u0301";
		stdin.write(`a${eCombining}c`);
		await tick();
		// Left once from end → between é and c. Insert X → "aéXc".
		stdin.write(LEFT);
		await tick();
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain(`submitted:a${eCombining}Xc`);
	});

	it("backspace removes a base character and its combining mark together", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		const eCombining = "e\u0301";
		stdin.write(`a${eCombining}`);
		await tick();
		stdin.write("\x7F");
		await tick();
		stdin.write("\r");
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("submitted:a");
		// The combining mark should not have survived on its own.
		expect(frame).not.toContain("\u0301");
	});

	it("right arrow over an emoji skips the whole cluster", async () => {
		const { lastFrame, stdin } = render(React.createElement(TestHarness));
		await tick();

		stdin.write("a🐻c");
		await tick();
		// Move cursor to start.
		for (let i = 0; i < 10; i++) stdin.write(LEFT);
		await tick();
		// Right once → past 'a' (pos=1). Right again → past 🐻 (pos=3).
		stdin.write(RIGHT);
		stdin.write(RIGHT);
		await tick();
		// Insert X at pos=3 → between 🐻 and c.
		stdin.write("X");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame()).toContain("submitted:a🐻Xc");
	});
});
