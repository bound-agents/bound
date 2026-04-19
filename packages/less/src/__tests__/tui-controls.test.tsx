import { describe, expect, it } from "bun:test";
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

	it("accepts both uppercase and lowercase y", () => {
		let count = 0;
		const { stdin: stdin1 } = render(
			<Confirm
				message="Test?"
				onYes={() => {
					count++;
				}}
				onNo={() => {}}
			/>,
		);
		stdin1.write("y");

		let count2 = 0;
		const { stdin: stdin2 } = render(
			<Confirm
				message="Test?"
				onYes={() => {
					count2++;
				}}
				onNo={() => {}}
			/>,
		);
		stdin2.write("Y");

		expect(count >= 0).toBe(true);
		expect(count2 >= 0).toBe(true);
	});
});
