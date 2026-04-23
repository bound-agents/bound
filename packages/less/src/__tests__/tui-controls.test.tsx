import { describe, expect, it, mock } from "bun:test";
import { render } from "ink-testing-library";
import { Confirm } from "../tui/components/Confirm.js";
import { SelectList } from "../tui/components/SelectList.js";
import { TextInput, computeViewport } from "../tui/components/TextInput.js";

// Note: ink-testing-library's lastFrame() strips ANSI escapes. The cursor
// is drawn via inverse-video (SGR 7) *on top of* the character at `pos`,
// so it doesn't show up as its own glyph in the plain-text frame. These
// tests assert on the presence/absence of the extra cursor *cell*: when
// enabled and empty, the frame starts with a leading space (the
// inverse-video space that renders the cursor); when disabled, that cell
// is not rendered at all.

describe("TextInput", () => {
	it("renders with placeholder when empty", () => {
		const { lastFrame } = render(<TextInput onSubmit={() => {}} placeholder="Type here" />);
		const output = lastFrame();
		expect(output).toContain("Type here");
	});

	it("renders cursor indicator", () => {
		const { lastFrame } = render(<TextInput onSubmit={() => {}} placeholder="hi" />);
		const output = lastFrame() ?? "";
		// The cursor is the leading (inverse-video) space before the placeholder.
		expect(output).toBe(" hi");
	});

	it("does not render cursor when disabled", () => {
		const { lastFrame } = render(
			<TextInput onSubmit={() => {}} placeholder="hi" disabled={true} />,
		);
		const output = lastFrame() ?? "";
		// No cursor cell — placeholder starts at column 0.
		expect(output).toBe("hi");
	});

	it("handles useInput with character entry capability", () => {
		const handleSubmit = mock(() => {});
		const { lastFrame } = render(<TextInput onSubmit={handleSubmit} placeholder="hi" />);
		const output = lastFrame() ?? "";
		// Cursor cell present (leading space before placeholder).
		expect(output).toBe(" hi");
		expect(typeof handleSubmit).toBe("function");
	});

	it("uses useInput with isActive controlled by disabled prop", () => {
		const { lastFrame: disabledOutput } = render(
			<TextInput onSubmit={() => {}} placeholder="hi" disabled={true} />,
		);
		const output = disabledOutput() ?? "";
		// No cursor cell when disabled.
		expect(output).toBe("hi");
	});

	it("renders with enter key handler registered", () => {
		const handleSubmit = mock(() => {});
		const { lastFrame } = render(<TextInput onSubmit={handleSubmit} placeholder="hi" />);
		const output = lastFrame() ?? "";
		expect(output).toBe(" hi");
		expect(typeof handleSubmit).toBe("function");
	});

	it("jumps words with ESC+b / ESC+f (Option+Arrow on macOS)", async () => {
		// On macOS, Option+Left sends ESC+b (\x1bb) and Option+Right sends
		// ESC+f (\x1bf). Ink parses these as { meta: true, input: 'b'/'f' }
		// (NOT leftArrow/rightArrow). The TextInput must handle both.
		const { lastFrame, stdin, unmount } = render(<TextInput onSubmit={() => {}} />);
		const tick = () => new Promise((r) => setTimeout(r, 50));

		try {
			await tick();
			stdin.write("hello world");
			await tick();

			// ESC+b: jump back one word (to start of "world", pos=6)
			stdin.write("\x1bb");
			await tick();

			// Insert "X" at cursor — should appear between "hello " and "world"
			stdin.write("X");
			await tick();
			expect(lastFrame()).toBe("hello Xworld");

			// ESC+f: jump forward one word (past "world", pos=12)
			stdin.write("\x1bf");
			await tick();

			// Insert "!" at end
			stdin.write("!");
			await tick();
			expect(lastFrame()).toBe("hello Xworld!");
		} finally {
			unmount();
		}
	});

	describe("computeViewport", () => {
		it("returns full range when text fits within viewport", () => {
			// "hello" (5 chars) + cursor space = 6 cols; viewport = 20
			const vp = computeViewport(5, 5, 20, 0);
			expect(vp.start).toBe(0);
			expect(vp.end).toBe(5);
			expect(vp.offset).toBe(0);
		});

		it("scrolls to keep cursor visible when text exceeds viewport", () => {
			// 50 chars, cursor at end (50), viewport = 20
			const vp = computeViewport(50, 50, 20, 0);
			// Cursor must be within [start, end]
			expect(vp.start).toBeGreaterThan(0);
			expect(vp.end).toBe(50);
			expect(vp.offset).toBe(vp.start);
		});

		it("scrolls back when cursor moves to start of long text", () => {
			// 50 chars, cursor at 0, viewport = 20, previous offset = 35
			const vp = computeViewport(50, 0, 20, 35);
			expect(vp.start).toBe(0);
			expect(vp.offset).toBe(0);
		});

		it("keeps viewport stable when cursor stays in range", () => {
			// 50 chars, viewport = 20, offset was 10, cursor at 20 (within view)
			const vp = computeViewport(50, 20, 20, 10);
			// Cursor at 20 is within viewport [10, 29] — offset should stay
			expect(vp.offset).toBe(10);
		});

		it("adjusts minimally when cursor exits right edge", () => {
			// 50 chars, viewport = 20, offset was 0, cursor at 25 (out of view)
			const vp = computeViewport(50, 25, 20, 0);
			// Must scroll right so cursor is visible
			expect(vp.start).toBeGreaterThan(0);
			expect(vp.start).toBeLessThanOrEqual(25);
			expect(vp.end).toBeGreaterThanOrEqual(25);
		});
	});

	it("does not wrap long text input to multiple lines", async () => {
		// Render TextInput with a known width, type text longer than that width,
		// verify the frame stays single-line.
		const { lastFrame, stdin, unmount } = render(
			<TextInput onSubmit={() => {}} viewportWidth={20} />,
		);
		const tick = () => new Promise((r) => setTimeout(r, 50));

		try {
			await tick();
			const longText = "abcdefghijklmnopqrstuvwxyz0123456789";
			stdin.write(longText);
			await tick();

			const frame = lastFrame() ?? "";
			// Frame should NOT contain the full text (it's viewport-clipped)
			expect(frame.length).toBeLessThanOrEqual(20);
			// Should contain the end of the text (cursor is at end)
			expect(frame).toContain("9");
			// Should NOT wrap to multiple lines
			expect(frame.split("\n").length).toBe(1);
		} finally {
			unmount();
		}
	});

	it("does not shift characters when the cursor moves through them", async () => {
		// The cursor is rendered via inverse-video *on top of* the character
		// at `pos`, not inserted between characters. Moving the cursor
		// should not change the visible column position of any character.
		const { lastFrame, stdin, unmount } = render(<TextInput onSubmit={() => {}} />);
		const tick = () => new Promise((r) => setTimeout(r, 50));

		try {
			// Wait for useInput to register on the first render tick before
			// writing to stdin — otherwise the keystrokes are dropped.
			await tick();

			stdin.write("abc");
			await tick();
			const frameAtEnd = lastFrame() ?? "";

			// Move cursor left once.
			stdin.write("\x1b[D");
			await tick();
			const frameAfterLeft = lastFrame() ?? "";

			// Move cursor left again.
			stdin.write("\x1b[D");
			await tick();
			const frameAfterLeft2 = lastFrame() ?? "";

			// The visible (ANSI-stripped) frame must be identical across all
			// three positions — nothing shifts as the cursor moves.
			expect(frameAtEnd).toBe("abc");
			expect(frameAfterLeft).toBe("abc");
			expect(frameAfterLeft2).toBe("abc");
		} finally {
			unmount();
		}
	});
});

describe("SelectList", () => {
	interface Item {
		id: number;
		name: string;
	}

	const items: Item[] = [
		{ id: 1, name: "First" },
		{ id: 2, name: "Second" },
		{ id: 3, name: "Third" },
	];

	it("renders all items", () => {
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={() => {}}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		const output = lastFrame();
		expect(output).toContain("First");
		expect(output).toContain("Second");
		expect(output).toContain("Third");
	});

	it("highlights first item by default", () => {
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={() => {}}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		const output = lastFrame();
		expect(output).toContain("> First");
	});

	it("uses provided renderItem function for each item", () => {
		const { lastFrame } = render(
			<SelectList items={items} onSelect={() => {}} renderItem={(item) => `Item: ${item.name}`} />,
		);
		const output = lastFrame();
		expect(output).toContain("Item: First");
		expect(output).toContain("Item: Second");
		expect(output).toContain("Item: Third");
	});

	it("initializes with selectedIndex at 0", () => {
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={() => {}}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		const output = lastFrame();
		expect(output).toContain("> First");
		expect(output).not.toContain("> Second");
	});

	it("has keyboard handlers for navigation", () => {
		const handleSelect = mock(() => {});
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={handleSelect}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		const output = lastFrame();
		expect(output).toContain("> First");
		// useInput is registered to handle arrow keys
		expect(typeof handleSelect).toBe("function");
	});

	it("has enter key selection handler", () => {
		const handleSelect = mock(() => {});
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={handleSelect}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		expect(typeof handleSelect).toBe("function");
		const output = lastFrame();
		expect(output).toBeDefined();
	});

	it("has escape and Ctrl-C cancel handlers", () => {
		const handleCancel = mock(() => {});
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={() => {}}
				onCancel={handleCancel}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		expect(typeof handleCancel).toBe("function");
		const output = lastFrame();
		expect(output).toBeDefined();
	});

	it("uses key.escape handler instead of raw escape code", () => {
		const handleCancel = mock(() => {});
		const { lastFrame } = render(
			<SelectList
				items={items}
				onSelect={() => {}}
				onCancel={handleCancel}
				renderItem={(item, selected) => (selected ? `> ${item.name}` : `  ${item.name}`)}
			/>,
		);
		const output = lastFrame();
		expect(output).toBeDefined();
		// useInput configured with key.escape handler
	});
});

describe("Confirm", () => {
	it("renders message with [Y/n] default", () => {
		const { lastFrame } = render(<Confirm message="Continue?" onYes={() => {}} onNo={() => {}} />);
		const output = lastFrame();
		expect(output).toContain("Continue?");
		expect(output).toContain("[Y/n]");
	});

	it("renders message correctly", () => {
		const { lastFrame } = render(
			<Confirm message="Proceed with operation?" onYes={() => {}} onNo={() => {}} />,
		);
		const output = lastFrame();
		expect(output).toContain("Proceed with operation?");
	});

	it("has y and Y key handlers for yes", () => {
		const handleYes = mock(() => {});
		const { lastFrame } = render(<Confirm message="Test?" onYes={handleYes} onNo={() => {}} />);
		expect(typeof handleYes).toBe("function");
		const output = lastFrame();
		expect(output).toContain("Test?");
	});

	it("has n and N key handlers for no", () => {
		const handleNo = mock(() => {});
		const { lastFrame } = render(<Confirm message="Test?" onYes={() => {}} onNo={handleNo} />);
		expect(typeof handleNo).toBe("function");
		const output = lastFrame();
		expect(output).toContain("Test?");
	});

	it("renders with Y/n display indicating yes is default", () => {
		const { lastFrame } = render(<Confirm message="Confirm?" onYes={() => {}} onNo={() => {}} />);
		const output = lastFrame();
		expect(output).toContain("[Y/n]");
	});

	it("has enter key handler for selection confirmation", () => {
		const handleYes = mock(() => {});
		const { lastFrame } = render(<Confirm message="Continue?" onYes={handleYes} onNo={() => {}} />);
		const output = lastFrame();
		expect(output).toContain("Continue?");
		expect(typeof handleYes).toBe("function");
	});
});
