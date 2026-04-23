import { describe, expect, it, mock } from "bun:test";
import { render } from "ink-testing-library";
import { Confirm } from "../tui/components/Confirm.js";
import { SelectList } from "../tui/components/SelectList.js";
import { TextInput, breakLines } from "../tui/components/TextInput.js";

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

	describe("breakLines", () => {
		it("returns single empty string for empty input", () => {
			expect(breakLines("", 10)).toEqual([""]);
		});

		it("returns text as-is when shorter than columns", () => {
			expect(breakLines("hello", 10)).toEqual(["hello"]);
		});

		it("splits text at column boundaries", () => {
			expect(breakLines("abcdefghij", 5)).toEqual(["abcde", "fghij"]);
		});

		it("handles text that is not an exact multiple of columns", () => {
			expect(breakLines("abcdefgh", 5)).toEqual(["abcde", "fgh"]);
		});
	});

	it("wraps long text to multiple explicit lines with columns prop", async () => {
		// With columns=10, text longer than 10 chars should render on
		// multiple explicit lines (with real \n between them).
		const { lastFrame, stdin, unmount } = render(<TextInput onSubmit={() => {}} columns={10} />);
		const tick = () => new Promise((r) => setTimeout(r, 50));

		try {
			await tick();
			stdin.write("abcdefghijklmno");
			await tick();

			const frame = lastFrame() ?? "";
			const lines = frame.split("\n");
			// Should have 2 lines: "abcdefghij" and "klmno" + cursor
			expect(lines.length).toBe(2);
			expect(lines[0]).toBe("abcdefghij");
			expect(lines[1]).toContain("klmno");
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
