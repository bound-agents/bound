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
});
