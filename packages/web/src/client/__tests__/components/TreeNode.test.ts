import { afterEach, describe, expect, it } from "bun:test";
import { SvelteSet } from "svelte/reactivity";
import type { FileTreeNode } from "../../lib/file-tree";
import { installDom } from "../harness/dom";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

function dir(name: string, fullPath: string, children: FileTreeNode[] = []): FileTreeNode {
	return { name, fullPath, type: "dir", children };
}

function file(name: string, fullPath: string): FileTreeNode {
	return { name, fullPath, type: "file", children: [] };
}

async function mount(props: Record<string, unknown>) {
	dom = installDom();
	const TreeNode = (await import("../../components/TreeNode.svelte")).default;
	const mounted = await dom.mount(TreeNode, props);
	await dom.settle();
	return mounted;
}

describe("TreeNode", () => {
	it("renders a directory node with its name and no arrow when it has no subfolders", async () => {
		const { target } = await mount({
			node: dir("src", "src"),
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: () => {},
			selectedPath: "",
			onSelectDirectory: () => {},
		});
		const node = target.querySelector(".node");
		expect(node).not.toBeNull();
		expect(target.querySelector(".name")?.textContent).toBe("src");
		// No subfolders → arrow hidden (opacity 0) and empty glyph.
		const arrow = target.querySelector(".arrow") as HTMLElement;
		expect(arrow.getAttribute("style")).toContain("opacity: 0");
		expect(arrow.textContent?.trim()).toBe("");
	});

	it("renders nothing for a file node (only directories render)", async () => {
		const { target } = await mount({
			node: file("README.md", "README.md"),
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: () => {},
			selectedPath: "",
			onSelectDirectory: () => {},
		});
		expect(target.querySelector(".node")).toBeNull();
	});

	it("shows a collapsed arrow (▶) when it has subfolders and is not expanded", async () => {
		const node = dir("src", "src", [dir("lib", "src/lib")]);
		const { target } = await mount({
			node,
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: () => {},
			selectedPath: "",
			onSelectDirectory: () => {},
		});
		const arrow = target.querySelector(".arrow") as HTMLElement;
		expect(arrow.getAttribute("style")).toContain("opacity: 1");
		expect(arrow.textContent?.trim()).toBe("▶");
		// Collapsed: the child dir is not rendered yet.
		expect(target.querySelectorAll(".node").length).toBe(1);
	});

	it("shows an expanded arrow (▼) and renders child directories when expanded", async () => {
		const node = dir("src", "src", [dir("lib", "src/lib"), file("x.ts", "src/x.ts")]);
		const expanded = new SvelteSet<string>(["src"]);
		const { target } = await mount({
			node,
			expandedPaths: expanded,
			toggleExpanded: () => {},
			selectedPath: "",
			onSelectDirectory: () => {},
		});
		const arrow = target.querySelector(".arrow") as HTMLElement;
		expect(arrow.textContent?.trim()).toBe("▼");
		// The child dir renders (recursion); the file child is filtered out.
		const names = [...target.querySelectorAll(".name")].map((n) => n.textContent);
		expect(names).toContain("src");
		expect(names).toContain("lib");
		expect(names).not.toContain("x.ts");
	});

	it("marks the node selected when selectedPath matches its fullPath", async () => {
		const { target } = await mount({
			node: dir("src", "src"),
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: () => {},
			selectedPath: "src",
			onSelectDirectory: () => {},
		});
		expect(target.querySelector(".node")?.classList.contains("selected")).toBe(true);
	});

	it("clicking an unselected dir with subfolders selects it without toggling", async () => {
		const node = dir("src", "src", [dir("lib", "src/lib")]);
		const selected: string[] = [];
		const toggled: string[] = [];
		const { target } = await mount({
			node,
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: (p: string) => toggled.push(p),
			selectedPath: "",
			onSelectDirectory: (p: string) => selected.push(p),
		});
		const el = target.querySelector(".node") as HTMLElement;
		await dom?.fire(el, "click");
		expect(selected).toEqual(["src"]);
		expect(toggled).toEqual([]);
	});

	it("clicking the selected dir with subfolders toggles expansion", async () => {
		const node = dir("src", "src", [dir("lib", "src/lib")]);
		const selected: string[] = [];
		const toggled: string[] = [];
		const { target } = await mount({
			node,
			expandedPaths: new SvelteSet<string>(["src"]),
			toggleExpanded: (p: string) => toggled.push(p),
			selectedPath: "src",
			onSelectDirectory: (p: string) => selected.push(p),
		});
		const el = target.querySelector(".node") as HTMLElement;
		await dom?.fire(el, "click");
		expect(selected).toEqual(["src"]);
		expect(toggled).toEqual(["src"]);
	});

	it("clicking a dir with no subfolders selects it but does not toggle expansion", async () => {
		const selected: string[] = [];
		const toggled: string[] = [];
		const { target } = await mount({
			node: dir("empty", "empty"),
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: (p: string) => toggled.push(p),
			selectedPath: "",
			onSelectDirectory: (p: string) => selected.push(p),
		});
		const el = target.querySelector(".node") as HTMLElement;
		await dom?.fire(el, "click");
		expect(selected).toEqual(["empty"]);
		expect(toggled).toEqual([]);
	});

	it("activates on Enter and Space keydown", async () => {
		const node = dir("src", "src", [dir("lib", "src/lib")]);
		const selected: string[] = [];
		const { target } = await mount({
			node,
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: () => {},
			selectedPath: "",
			onSelectDirectory: (p: string) => selected.push(p),
		});
		const el = target.querySelector(".node") as HTMLElement;
		await dom?.fire(el, "keydown", { key: "Enter" });
		await dom?.fire(el, "keydown", { key: " " });
		expect(selected).toEqual(["src", "src"]);
	});

	it("ignores unrelated keys", async () => {
		const selected: string[] = [];
		const { target } = await mount({
			node: dir("src", "src", [dir("lib", "src/lib")]),
			expandedPaths: new SvelteSet<string>(),
			toggleExpanded: () => {},
			selectedPath: "",
			onSelectDirectory: (p: string) => selected.push(p),
		});
		const el = target.querySelector(".node") as HTMLElement;
		await dom?.fire(el, "keydown", { key: "a" });
		expect(selected).toEqual([]);
	});
});
