import { type Page, expect, test } from "@playwright/test";
import { json, mockAmbient } from "./helpers/mocks";

// 1x1 transparent PNG.
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';

interface Fixture {
	path: string;
	content: string | null;
	is_binary?: number;
	size_bytes?: number;
}

const FIXTURES: Fixture[] = [
	{
		path: "home/user/src/app.ts",
		content: 'export function hello(): string {\n\treturn "world";\n}\n',
	},
	{ path: "home/user/src/utils.ts", content: "export const x = 1;\n" },
	{ path: "home/user/docs/readme.md", content: "# Hello\n\nThis is **bold** text." },
	{ path: "home/user/docs/archive/old.md", content: "# Old" },
	{ path: "home/user/assets/icon.png", content: PNG, is_binary: 1 },
	{ path: "home/user/assets/logo.svg", content: SVG },
	{ path: "home/user/notes.txt", content: "plain text notes" },
	{ path: "home/user/data.bin", content: "AAEC", is_binary: 1 },
	{ path: "home/user/empty.txt", content: null, size_bytes: 0 },
	{ path: "home/user/config.json", content: '{"a":1}' },
];

const row = (f: Fixture, i: number) => ({
	id: String(i + 1),
	path: f.path,
	is_binary: f.is_binary ?? 0,
	size_bytes: f.size_bytes ?? (f.content?.length || 1),
	content: f.content,
	created_at: "2026-03-30T00:00:00Z",
	modified_at: "2026-03-30T00:00:00Z",
	deleted: 0,
	created_by: "agent",
	host_origin: "local",
});

async function openFiles(page: Page, opts: { failFirst?: string } = {}): Promise<void> {
	await mockAmbient(page);
	const rows = FIXTURES.map(row);
	let failed = false;
	await page.route("**/api/files/**", (route) => {
		const path = decodeURIComponent(
			new URL(route.request().url()).pathname.slice("/api/files/".length),
		);
		if (opts.failFirst === path && !failed) {
			failed = true;
			return json(route, { error: "Server error" }, 500);
		}
		const file = rows.find((r) => r.path === path);
		return file ? json(route, file) : json(route, { error: "not found" }, 404);
	});
	await page.route("**/api/files", (route) =>
		json(
			route,
			rows.map(({ content: _c, ...meta }) => meta),
		),
	);
	await page.goto("/#/files");
	await expect(page.locator(".files-browser")).toBeVisible();
}

const tree = (page: Page) => page.locator(".tree-sidebar");
const listRow = (page: Page, name: string) =>
	page.locator(".listing .row").filter({
		has: page.locator(".name", {
			hasText: new RegExp(`^\\s*${name.replace(".", "\\.")}/?\\s*$`),
		}),
	});

async function goTo(page: Page, ...segments: string[]): Promise<void> {
	for (const s of segments) await listRow(page, s).click();
	await expect(page.locator(".crumb.last")).toHaveText(segments[segments.length - 1]);
}

async function openFile(page: Page, dirs: string[], name: string): Promise<void> {
	await goTo(page, ...dirs);
	await listRow(page, name).click();
	await expect(page.locator(".modal-panel")).toBeVisible();
	await expect(page.locator(".modal-title")).toHaveText(name);
}

test.describe("Files viewer layout and navigation", () => {
	test("AC1.1: tree sidebar and content area render side by side", async ({ page }) => {
		await openFiles(page);
		await expect(tree(page)).toBeAttached();
		await expect(page.locator(".content-area")).toBeVisible();
		await expect(page.locator(".listing-header")).toContainText("Name");
		await expect(listRow(page, "home")).toBeVisible();
	});

	test("AC1.2: expanding and collapsing a tree directory keeps the content area", async ({
		page,
	}) => {
		await openFiles(page);
		const sidebar = tree(page);
		test.skip(!(await sidebar.isVisible()), "tree sidebar is hidden on narrow viewports");
		const before = await page.locator(".content-area").boundingBox();
		const home = sidebar.locator(".node", { hasText: "home" }).first();
		await home.click();
		await expect(sidebar.locator(".node", { hasText: "user" })).toBeVisible();
		await home.click();
		const after = await page.locator(".content-area").boundingBox();
		expect(after?.x).toBe(before?.x);
		expect(after?.width).toBe(before?.width);
	});

	test("AC1.5: selecting a tree directory highlights it and lists its contents", async ({
		page,
	}) => {
		await openFiles(page);
		const sidebar = tree(page);
		test.skip(!(await sidebar.isVisible()), "tree sidebar is hidden on narrow viewports");
		const home = sidebar.locator(".node", { hasText: "home" }).first();
		await home.click();
		await expect(home).toHaveClass(/selected/);
		await expect(listRow(page, "user")).toBeVisible();
	});

	test("AC1.3: breadcrumbs show the current path", async ({ page }) => {
		await openFiles(page);
		await goTo(page, "home", "user", "src");
		await expect(page.locator(".breadcrumbs .crumb")).toHaveText(["/", "home", "user", "src"]);
	});

	test("AC1.4: clicking a breadcrumb navigates up", async ({ page }) => {
		await openFiles(page);
		await goTo(page, "home", "user", "src");
		await page.locator(".breadcrumbs .crumb", { hasText: "user" }).click();
		await expect(page.locator(".crumb.last")).toHaveText("user");
		await expect(listRow(page, "config.json")).toBeVisible();
	});

	test("AC1.6: clicking a folder row navigates into it", async ({ page }) => {
		await openFiles(page);
		await goTo(page, "home", "user", "docs");
		await expect(listRow(page, "readme.md")).toBeVisible();
		await expect(listRow(page, "archive")).toBeVisible();
	});

	test("AC1.7: an empty file list shows the empty state", async ({ page }) => {
		await mockAmbient(page);
		await page.route("**/api/files", (route) => json(route, []));
		await page.goto("/#/files");
		await expect(page.getByText("No files yet.")).toBeVisible();
	});
});

test.describe("File preview modal", () => {
	test("AC2.1: opens the modal on file click", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user", "src"], "app.ts");
	});

	test("AC2.2: code renders syntax highlighted", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user", "src"], "app.ts");
		const code = page.locator(".preview-code");
		await expect(code).toContainText("hello");
		await expect(code.locator("span").first()).toBeAttached();
	});

	test("AC2.3: markdown renders as HTML", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user", "docs"], "readme.md");
		const md = page.locator(".preview-markdown");
		await expect(md.locator("h1")).toHaveText("Hello");
		await expect(md.locator("strong")).toHaveText("bold");
	});

	test("AC2.4: PNG renders inline from base64 content", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user", "assets"], "icon.png");
		const img = page.locator(".preview-image img");
		await expect(img).toBeVisible();
		await expect(img).toHaveAttribute("src", /^blob:/);
	});

	test("AC2.4: SVG renders inline from raw text content", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user", "assets"], "logo.svg");
		await expect(page.locator(".preview-image img")).toHaveAttribute("src", /^blob:/);
	});

	test("AC2.5: plain text renders in a monospace pre", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "notes.txt");
		const pre = page.locator("pre.preview-text");
		await expect(pre).toHaveText("plain text notes");
		const font = await pre.evaluate((el) => getComputedStyle(el).fontFamily);
		expect(font.toLowerCase()).toMatch(/mono|courier|consolas/);
	});

	test("AC2.6: shows the filename and a download action", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "notes.txt");
		await expect(page.locator(".modal-panel .action-btn")).toBeVisible();
	});

	test("AC2.7: closes via the close button", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "notes.txt");
		await page.locator(".close-btn").click();
		await expect(page.locator(".modal-panel")).toHaveCount(0);
	});

	test("AC2.7: closes via Escape", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "notes.txt");
		await page.keyboard.press("Escape");
		await expect(page.locator(".modal-panel")).toHaveCount(0);
	});

	test("AC2.7: closes via backdrop click", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "notes.txt");
		await page.locator(".modal-backdrop").click({ position: { x: 4, y: 4 } });
		await expect(page.locator(".modal-panel")).toHaveCount(0);
	});

	test("AC2.8: binary files show the download fallback", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "data.bin");
		await expect(page.locator(".preview-binary .download-btn-large")).toBeVisible();
	});

	test("AC2.9: load failure shows an error with a working retry", async ({ page }) => {
		await openFiles(page, { failFirst: "home/user/src/app.ts" });
		await openFile(page, ["home", "user", "src"], "app.ts");
		await expect(page.locator(".modal-error")).toBeVisible();
		await page.locator(".retry-btn").click();
		await expect(page.locator(".preview-code")).toContainText("hello");
	});

	test("AC2.10: empty files show the empty message", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "empty.txt");
		await expect(page.locator(".modal-empty")).toBeVisible();
	});

	test("AC2.11: Tab keeps focus inside the modal", async ({ page }) => {
		await openFiles(page);
		await openFile(page, ["home", "user"], "notes.txt");
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Tab");
			const inside = await page.evaluate(() => !!document.activeElement?.closest(".modal-panel"));
			expect(inside).toBe(true);
		}
	});
});
