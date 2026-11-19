import { afterEach, describe, expect, it } from "bun:test";
import type { FileMetadata, FileTreeNode } from "../../lib/file-tree";
import { installDom } from "../harness/dom";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

function meta(overrides: Partial<FileMetadata> = {}): FileMetadata {
	return {
		id: "f1",
		path: "docs/readme.md",
		is_binary: 0,
		size_bytes: 2048,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-02T00:00:00.000Z",
		deleted: 0,
		created_by: null,
		host_origin: "host-a",
		...overrides,
	} as FileMetadata;
}

function fileNode(name: string, fullPath: string, file: FileMetadata): FileTreeNode {
	return { name, fullPath, type: "file", children: [], file };
}

function dirNode(name: string, fullPath: string): FileTreeNode {
	return { name, fullPath, type: "dir", children: [] };
}

// getFileIcon must return a Svelte component; the template renders file-row
// icons via `<Icon size={16} />`. The real app passes a lucide icon, so reuse
// the lucide Folder icon (which mounts cleanly under this jsdom harness) as the
// file-icon stand-in.
async function iconComponent() {
	return (await import("lucide-svelte")).Folder;
}

async function mount(props: Record<string, unknown>) {
	dom = installDom();
	const DirectoryListing = (await import("../../components/DirectoryListing.svelte")).default;
	const mounted = await dom.mount(DirectoryListing, props);
	await dom.settle();
	return mounted;
}

const baseProps = async () => ({
	formatFileSize: (b: number) => `${b} B`,
	getFileIcon: () => iconComponent,
	relativeTime: (iso: string | null) => (iso ? `t:${iso}` : "never"),
	onSelectDirectory: () => {},
	onSelectFile: () => {},
});

describe("DirectoryListing", () => {
	it("renders the empty state when there are no items", async () => {
		const { target } = await mount({ ...(await baseProps()), items: [] });
		expect(target.querySelector(".empty-directory")).not.toBeNull();
		expect(target.textContent).toContain("This directory is empty");
		expect(target.querySelector(".listing-header")).toBeNull();
	});

	it("renders a header and one row per item with name, size and modified", async () => {
		const f = meta({ path: "docs/a.md", size_bytes: 1500, modified_at: "2026-03-01T00:00:00Z" });
		const { target } = await mount({
			...(await baseProps()),
			items: [dirNode("sub", "docs/sub"), fileNode("a.md", "docs/a.md", f)],
		});
		expect(target.querySelector(".listing-header")).not.toBeNull();
		const rows = [...target.querySelectorAll(".listing-row")];
		expect(rows.length).toBe(2);
		// Directory row: dir class, em-dash for size + modified.
		expect(rows[0].classList.contains("listing-dir")).toBe(true);
		expect(rows[0].querySelector(".item-name")?.textContent).toBe("sub");
		expect(rows[0].querySelector(".col-size")?.textContent?.trim()).toBe("—");
		// File row: file class, formatted size + relative time.
		expect(rows[1].classList.contains("listing-file")).toBe(true);
		expect(rows[1].querySelector(".item-name")?.textContent).toBe("a.md");
		expect(rows[1].querySelector(".col-size")?.textContent?.trim()).toBe("1500 B");
		expect(rows[1].querySelector(".col-modified")?.textContent?.trim()).toBe(
			"t:2026-03-01T00:00:00Z",
		);
	});

	it("clicking a directory row fires onSelectDirectory with its path", async () => {
		const dirs: string[] = [];
		const { target } = await mount({
			...(await baseProps()),
			items: [dirNode("sub", "docs/sub")],
			onSelectDirectory: (p: string) => dirs.push(p),
		});
		await dom?.fire(target.querySelector(".listing-row") as HTMLElement, "click");
		expect(dirs).toEqual(["docs/sub"]);
	});

	it("clicking a file row fires onSelectFile with its file metadata", async () => {
		const f = meta({ path: "docs/a.md" });
		const files: FileMetadata[] = [];
		const { target } = await mount({
			...(await baseProps()),
			items: [fileNode("a.md", "docs/a.md", f)],
			onSelectFile: (file: FileMetadata) => files.push(file),
		});
		await dom?.fire(target.querySelector(".listing-row") as HTMLElement, "click");
		expect(files.length).toBe(1);
		expect(files[0].path).toBe("docs/a.md");
	});

	it("Enter key on a directory row triggers onSelectDirectory", async () => {
		const dirs: string[] = [];
		const { target } = await mount({
			...(await baseProps()),
			items: [dirNode("sub", "docs/sub")],
			onSelectDirectory: (p: string) => dirs.push(p),
		});
		await dom?.fire(target.querySelector(".listing-row") as HTMLElement, "keydown", {
			key: "Enter",
		});
		expect(dirs).toEqual(["docs/sub"]);
	});

	it("Space key on a file row triggers onSelectFile", async () => {
		const f = meta({ path: "docs/a.md" });
		const files: FileMetadata[] = [];
		const { target } = await mount({
			...(await baseProps()),
			items: [fileNode("a.md", "docs/a.md", f)],
			onSelectFile: (file: FileMetadata) => files.push(file),
		});
		await dom?.fire(target.querySelector(".listing-row") as HTMLElement, "keydown", { key: " " });
		expect(files.length).toBe(1);
	});

	it("ignores unrelated keys", async () => {
		const dirs: string[] = [];
		const { target } = await mount({
			...(await baseProps()),
			items: [dirNode("sub", "docs/sub")],
			onSelectDirectory: (p: string) => dirs.push(p),
		});
		await dom?.fire(target.querySelector(".listing-row") as HTMLElement, "keydown", { key: "x" });
		expect(dirs).toEqual([]);
	});

	it("a directory node without a file still renders a dash in both columns", async () => {
		const { target } = await mount({
			...(await baseProps()),
			items: [dirNode("sub", "docs/sub")],
		});
		const row = target.querySelector(".listing-row") as HTMLElement;
		expect(row.querySelector(".col-size")?.textContent?.trim()).toBe("—");
		expect(row.querySelector(".col-modified")?.textContent?.trim()).toBe("—");
	});
});
