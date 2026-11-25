import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// FilesView: loads the agent workspace file list via BoundClient.listFiles()
// (GET /api/files), builds a tree, and renders a sidebar (TreeNode children) +
// a directory listing with breadcrumbs. Rows open a FilePreviewModal (which
// fetches GET /api/files/:path). It reloads on a `file:updated` WS event.
// These tests drive the real compiled view (and its children) under jsdom.

const dom = installDom();
afterAll(() => dom.teardown());

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

function fileEntry(path: string, extra: Record<string, unknown> = {}) {
	return {
		id: path,
		path,
		is_binary: 0,
		size_bytes: 1024,
		created_at: new Date().toISOString(),
		modified_at: new Date().toISOString(),
		deleted: 0,
		created_by: null,
		host_origin: "h1",
		...extra,
	};
}

async function mountView() {
	const FilesView = (await import("../../views/FilesView.svelte")).default;
	const handle = await dom.mount(FilesView, {});
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

describe("FilesView", () => {
	beforeEach(() => {
		dom.requests.length = 0;
	});

	it("shows the empty state when there are no files", async () => {
		dom.route("GET", "/api/files", () => []);
		const { target } = await mountView();
		expect(target.textContent).toContain("No files yet.");
	});

	it("shows the error state when the file list request fails", async () => {
		dom.route(
			"GET",
			"/api/files",
			() => new Response(JSON.stringify({ error: "disk gone" }), { status: 500 }),
		);
		const { target } = await mountView();
		expect(target.querySelector(".state.err")?.textContent).toContain("disk gone");
	});

	it("loads files and renders the root listing with a file count", async () => {
		dom.route("GET", "/api/files", () => [
			fileEntry("notes.md"),
			fileEntry("data.csv"),
			fileEntry("src/index.ts"),
		]);
		const { target } = await mountView();
		// Three top-level entries: two files + one directory.
		expect(target.querySelector(".files-browser")).not.toBeNull();
		expect(target.textContent).toContain("notes.md");
		expect(target.textContent).toContain("data.csv");
		expect(target.textContent).toContain("src/");
		// Count ticket: 2 files · 1 folder at the root.
		expect(target.textContent).toContain("2");
		expect(target.textContent).toContain("files");
		expect(target.textContent).toContain("folder");
	});

	it("requested the file list exactly once on mount", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("a.txt")]);
		await mountView();
		const gets = dom.requests.filter((r) => r.path === "/api/files" && r.method === "GET");
		expect(gets.length).toBe(1);
	});

	it("navigates into a directory via a row click and updates breadcrumbs", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("src/index.ts"), fileEntry("src/util.ts")]);
		const { target } = await mountView();
		// Find the "src/" directory row and click it.
		const rows = Array.from(target.querySelectorAll(".listing .row")) as HTMLElement[];
		const srcRow = rows.find((r) => r.textContent?.includes("src/"));
		expect(srcRow).toBeDefined();
		await dom.fire(srcRow as HTMLElement, "click");
		// Breadcrumb now shows the "src" segment, and the listing shows the children.
		const crumbs = Array.from(target.querySelectorAll(".breadcrumbs .crumb")).map((c) =>
			c.textContent?.trim(),
		);
		expect(crumbs).toContain("src");
		expect(target.textContent).toContain("index.ts");
		expect(target.textContent).toContain("util.ts");
	});

	it("returns to root when the root breadcrumb is clicked", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("dir/inner.ts")]);
		const { target } = await mountView();
		const rows = Array.from(target.querySelectorAll(".listing .row")) as HTMLElement[];
		await dom.fire(rows.find((r) => r.textContent?.includes("dir/")) as HTMLElement, "click");
		expect(target.textContent).toContain("inner.ts");
		// Click the leading "/" breadcrumb to go home.
		const rootCrumb = target.querySelector(".breadcrumbs .crumb") as HTMLButtonElement;
		await dom.fire(rootCrumb, "click");
		expect(target.textContent).toContain("dir/");
	});

	it("opens the FilePreviewModal when a file's Open button is clicked", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("readme.md", { size_bytes: 42 })]);
		dom.route("GET", /\/api\/files\/.+/, () => ({
			...fileEntry("readme.md", { size_bytes: 42 }),
			content: "# Readme\n\nbody",
		}));
		const { target } = await mountView();
		const openBtn = target.querySelector(".open-btn") as HTMLButtonElement;
		expect(openBtn).not.toBeNull();
		await dom.fire(openBtn, "click");
		await dom.settle();
		// FilePreviewModal mounts and fetches the file content.
		const fileGets = dom.requests.filter(
			(r) => r.method === "GET" && /\/api\/files\/.+/.test(r.path),
		);
		expect(fileGets.length).toBeGreaterThanOrEqual(1);
	});

	it("opens a file preview on Enter keydown over a file row", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("doc.txt")]);
		dom.route("GET", /\/api\/files\/.+/, () => ({
			...fileEntry("doc.txt"),
			content: "hi",
		}));
		const { target } = await mountView();
		const fileRow = Array.from(target.querySelectorAll(".listing .row")).find((r) =>
			r.textContent?.includes("doc.txt"),
		) as HTMLElement;
		await dom.fire(fileRow, "keydown", { key: "Enter" });
		await dom.settle();
		const fileGets = dom.requests.filter(
			(r) => r.method === "GET" && /\/api\/files\/.+/.test(r.path),
		);
		expect(fileGets.length).toBeGreaterThanOrEqual(1);
	});

	it("reloads the file list on a file:updated WebSocket event", async () => {
		let payload: ReturnType<typeof fileEntry>[] = [fileEntry("one.md")];
		dom.route("GET", "/api/files", () => payload);
		const { target } = await mountView();
		expect(target.textContent).toContain("one.md");
		expect(dom.requests.filter((r) => r.path === "/api/files").length).toBe(1);

		// Emit a file:updated event through the shared wsEvents store.
		const { wsEvents } = await import("../../lib/bound");
		payload = [fileEntry("one.md"), fileEntry("two.md")];
		wsEvents.update((events) => [...events, { type: "file:updated", data: {} }]);
		await dom.settle();
		expect(dom.requests.filter((r) => r.path === "/api/files").length).toBe(2);
		expect(target.textContent).toContain("two.md");
	});

	it("does not reload on an unrelated WebSocket event", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("x.md")]);
		await mountView();
		const before = dom.requests.filter((r) => r.path === "/api/files").length;
		const { wsEvents } = await import("../../lib/bound");
		wsEvents.update((events) => [...events, { type: "task:updated", data: {} }]);
		await dom.settle();
		expect(dom.requests.filter((r) => r.path === "/api/files").length).toBe(before);
	});

	it("formats file sizes across the B/KB/MB/GB thresholds", async () => {
		dom.route("GET", "/api/files", () => [
			fileEntry("tiny.bin", { size_bytes: 0 }),
			fileEntry("small.bin", { size_bytes: 512 }),
			fileEntry("kb.bin", { size_bytes: 2048 }),
			fileEntry("mb.bin", { size_bytes: 5 * 1024 * 1024 }),
			fileEntry("gb.bin", { size_bytes: 3 * 1024 * 1024 * 1024 }),
		]);
		const { target } = await mountView();
		const text = target.textContent ?? "";
		expect(text).toContain("0 B");
		expect(text).toContain("512 B");
		expect(text).toContain("2.0 KB");
		expect(text).toContain("5.0 MB");
		expect(text).toContain("3.0 GB");
	});

	it("renders relative-time labels for recent and older files", async () => {
		const now = Date.now();
		const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
		dom.route("GET", "/api/files", () => [
			fileEntry("now.md", { modified_at: iso(10_000) }), // < 1 min → "just now"
			fileEntry("mins.md", { modified_at: iso(5 * 60_000) }), // "5m ago"
			fileEntry("hours.md", { modified_at: iso(3 * 3_600_000) }), // "3h ago"
			fileEntry("days.md", { modified_at: iso(2 * 86_400_000) }), // "2d ago"
		]);
		const { target } = await mountView();
		const text = target.textContent ?? "";
		expect(text).toContain("just now");
		expect(text).toContain("5m ago");
		expect(text).toContain("3h ago");
		expect(text).toContain("2d ago");
	});

	it("shows an em-dash modified label and 'items' count for directories", async () => {
		dom.route("GET", "/api/files", () => [fileEntry("folder/a.txt"), fileEntry("folder/b.txt")]);
		const { target } = await mountView();
		// The root listing shows the "folder" dir row with a 2-items size and an em-dash modified cell.
		const dirRow = Array.from(target.querySelectorAll(".listing .row")).find((r) =>
			r.textContent?.includes("folder/"),
		) as HTMLElement;
		expect(dirRow.textContent).toContain("2 items");
		expect(dirRow.textContent).toContain("\u2014");
	});

	it("toggles tree expansion when a nested directory is clicked in the sidebar", async () => {
		// A dir that contains a subdir renders a TreeNode with a toggle arrow; clicking
		// the node div drives FilesView.toggleExpanded via TreeNode.handleClick. The
		// arrow glyph (▼ expanded / ▶ collapsed) is the deterministic observable.
		dom.route("GET", "/api/files", () => [fileEntry("outer/inner/leaf.ts")]);
		const { target } = await mountView();
		const sidebar = target.querySelector(".tree-sidebar") as HTMLElement;
		const outerNode = Array.from(sidebar.querySelectorAll(".node")).find(
			(n) => n.querySelector(".name")?.textContent?.trim() === "outer",
		) as HTMLElement;
		expect(outerNode).toBeDefined();
		// Expanded on load (expandAllRecursive) — arrow shows ▼.
		expect(outerNode.querySelector(".arrow")?.textContent?.trim()).toBe("\u25bc");
		// First click selects the directory and keeps it expanded.
		await dom.fire(outerNode, "click");
		expect(outerNode.querySelector(".arrow")?.textContent?.trim()).toBe("\u25bc");
		// Clicking the already-selected directory collapses it.
		await dom.fire(outerNode, "click");
		// toggleExpanded removed the path → arrow flips to ▶.
		const outerAfter = Array.from(sidebar.querySelectorAll(".node")).find(
			(n) => n.querySelector(".name")?.textContent?.trim() === "outer",
		) as HTMLElement;
		expect(outerAfter.querySelector(".arrow")?.textContent?.trim()).toBe("\u25b6");
	});
});
