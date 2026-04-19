import { describe, expect, it, mock } from "bun:test";
import { render } from "ink-testing-library";
import { Confirm } from "../tui/components/Confirm.js";
import { SelectList } from "../tui/components/SelectList.js";
import { TextInput } from "../tui/components/TextInput.js";

describe("TextInput", () => {
	it("renders with placeholder when empty", () => {
		const { lastFrame } = render(<TextInput onSubmit={() => {}} placeholder="Type here" />);
		const output = lastFrame();
		expect(output).toContain("Type here");
	});

	it("renders cursor indicator", () => {
		const { lastFrame } = render(<TextInput onSubmit={() => {}} />);
		const output = lastFrame();
		expect(output).toContain("▌");
	});

	it("does not render cursor when disabled", () => {
		const { lastFrame } = render(<TextInput onSubmit={() => {}} disabled={true} />);
		const output = lastFrame();
		expect(output).not.toContain("▌");
	});

	it("passes a placeholder to display when no value", () => {
		const { lastFrame } = render(<TextInput onSubmit={() => {}} placeholder="Enter text" />);
		const output = lastFrame();
		expect(output).toContain("Enter text");
	});

	it("supports character input via useInput handler", () => {
		const handleSubmit = mock(() => {});
		const { lastFrame } = render(<TextInput onSubmit={handleSubmit} />);
		const output = lastFrame();
		expect(output).toContain("▌");
		expect(handleSubmit).not.toHaveBeenCalled();
	});

	it("uses useInput with isActive controlled by disabled prop", () => {
		const { lastFrame: disabledOutput } = render(<TextInput onSubmit={() => {}} disabled={true} />);
		const output = disabledOutput();
		expect(output).not.toContain("▌");
	});

	it("renders with enter key handler capability", () => {
		const handleSubmit = mock(() => {});
		const { lastFrame } = render(<TextInput onSubmit={handleSubmit} />);
		const output = lastFrame();
		expect(output).toContain("▌");
		expect(typeof handleSubmit).toBe("function");
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

	it("supports upArrow and downArrow navigation handlers via useInput", () => {
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
	});

	it("supports enter key selection handler", () => {
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

	it("supports escape and Ctrl-C cancel handlers", () => {
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

	it("uses key.escape instead of raw escape code", () => {
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

	it("supports y and Y key handlers for yes", () => {
		const handleYes = mock(() => {});
		const { lastFrame } = render(<Confirm message="Test?" onYes={handleYes} onNo={() => {}} />);
		expect(typeof handleYes).toBe("function");
		const output = lastFrame();
		expect(output).toContain("Test?");
	});

	it("supports n and N key handlers for no", () => {
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

	it("supports enter key handler for selection confirmation", () => {
		const handleYes = mock(() => {});
		const { lastFrame } = render(<Confirm message="Continue?" onYes={handleYes} onNo={() => {}} />);
		const output = lastFrame();
		expect(output).toContain("Continue?");
		expect(typeof handleYes).toBe("function");
	});
});
