import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { type SidebarItem, sidebar } from "../src/sidebar";

const packageRoot = resolve(import.meta.dir, "..");
const contentRoot = join(packageRoot, "src", "content", "docs");
const distRoot = join(packageRoot, "dist");
const siteBase = "/bound/";
const errors: string[] = [];

interface Frontmatter {
	title?: unknown;
	description?: unknown;
}

interface Page {
	file: string;
	slug: string;
	title: string;
	description: string;
}

function walkFiles(root: string, extension: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return walkFiles(path, extension);
		return entry.isFile() && extname(entry.name) === extension ? [path] : [];
	});
}

function displayPath(path: string): string {
	return relative(packageRoot, path).split(sep).join("/");
}

function parsePage(file: string): Page | null {
	const source = readFileSync(file, "utf8");
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) {
		errors.push(`${displayPath(file)}: missing YAML frontmatter`);
		return null;
	}

	let frontmatter: Frontmatter;
	try {
		frontmatter = parse(match[1]) as Frontmatter;
	} catch (error) {
		errors.push(`${displayPath(file)}: invalid YAML frontmatter (${String(error)})`);
		return null;
	}

	const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
	const description =
		typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

	if (!title) errors.push(`${displayPath(file)}: frontmatter title must be a nonempty string`);
	if (!description) {
		errors.push(`${displayPath(file)}: frontmatter description must be a nonempty string`);
	}
	if (description.length > 160) {
		errors.push(`${displayPath(file)}: description exceeds 160 characters`);
	}

	const relativePath = relative(contentRoot, file).split(sep).join("/");
	const slug = relativePath === "index.md" ? "index" : relativePath.replace(/\.md$/, "");
	return { file, slug, title, description };
}

function flattenSidebarItems(items: SidebarItem[]): string[] {
	return items.flatMap((item) => ("slug" in item ? [item.slug] : []));
}

function checkSourceStructure(): void {
	const pages = walkFiles(contentRoot, ".md")
		.map(parsePage)
		.filter((page): page is Page => page !== null);
	const pageSlugs = new Set(pages.map((page) => page.slug));
	const sidebarSlugs = sidebar.flatMap((group) => flattenSidebarItems(group.items));
	const sidebarSlugSet = new Set(sidebarSlugs);

	for (const slug of pageSlugs) {
		if (!sidebarSlugSet.has(slug)) errors.push(`sidebar: missing page slug "${slug}"`);
	}
	for (const slug of sidebarSlugs) {
		if (!pageSlugs.has(slug)) errors.push(`sidebar: unknown page slug "${slug}"`);
	}

	const duplicateSlugs = sidebarSlugs.filter((slug, index) => sidebarSlugs.indexOf(slug) !== index);
	for (const slug of new Set(duplicateSlugs)) {
		errors.push(`sidebar: duplicate page slug "${slug}"`);
	}

	const titles = new Map<string, string>();
	for (const page of pages) {
		const existing = titles.get(page.title);
		if (existing) {
			errors.push(
				`${displayPath(page.file)}: title "${page.title}" duplicates ${displayPath(existing)}`,
			);
		} else {
			titles.set(page.title, page.file);
		}
	}
}

interface HtmlPage {
	file: string;
	ids: Set<string>;
	links: string[];
}

async function readHtmlPage(file: string): Promise<HtmlPage> {
	const ids = new Set<string>();
	const links: string[] = [];
	const source = readFileSync(file, "utf8");
	const response = new HTMLRewriter()
		.on("[id]", {
			element(element) {
				const id = element.getAttribute("id");
				if (id) ids.add(id);
			},
		})
		.on("a[href]", {
			element(element) {
				const href = element.getAttribute("href");
				if (href) links.push(href);
			},
		})
		.transform(new Response(source));
	await response.text();
	return { file, ids, links };
}

function routeForFile(file: string): string {
	const path = relative(distRoot, file).split(sep).join("/");
	if (path === "index.html") return siteBase;
	return `${siteBase}${path.replace(/index\.html$/, "")}`;
}

function fileForPathname(pathname: string): string | null {
	if (!pathname.startsWith(siteBase)) return null;
	const relativePath = decodeURIComponent(pathname.slice(siteBase.length));
	if (!relativePath) return join(distRoot, "index.html");
	if (relativePath.endsWith("/")) return join(distRoot, relativePath, "index.html");
	if (extname(relativePath) === ".html") return join(distRoot, relativePath);
	return null;
}

async function checkGeneratedLinks(): Promise<void> {
	if (!existsSync(distRoot)) {
		errors.push("dist: missing generated site; run the Astro build before check-docs");
		return;
	}

	const htmlPages = await Promise.all(walkFiles(distRoot, ".html").map(readHtmlPage));
	const pagesByFile = new Map(htmlPages.map((page) => [resolve(page.file), page]));

	for (const page of htmlPages) {
		const sourceRoute = routeForFile(page.file);
		for (const href of page.links) {
			if (
				href.startsWith("http:") ||
				href.startsWith("https:") ||
				href.startsWith("mailto:") ||
				href.startsWith("tel:") ||
				href.startsWith("//")
			) {
				continue;
			}

			const targetUrl = new URL(href, `https://docs.invalid${sourceRoute}`);
			const targetFile = fileForPathname(targetUrl.pathname);
			if (!targetFile) continue;

			const targetPage = pagesByFile.get(resolve(targetFile));
			if (!targetPage) {
				errors.push(`${displayPath(page.file)}: broken internal link "${href}"`);
				continue;
			}

			const fragment = decodeURIComponent(targetUrl.hash.slice(1));
			if (fragment && !targetPage.ids.has(fragment)) {
				errors.push(`${displayPath(page.file)}: missing fragment "#${fragment}" in "${href}"`);
			}
		}
	}
}

function checkThemeContracts(): void {
	const themeFile = join(packageRoot, "src", "styles", "theme.css");
	const theme = readFileSync(themeFile, "utf8");
	const minimalButton = theme.match(/\.sl-link-button\.minimal\s*\{([\s\S]*?)\}/)?.[1];
	if (!minimalButton || !/\bpadding(?:-inline)?\s*:/.test(minimalButton)) {
		errors.push(
			"src/styles/theme.css: bordered minimal link button must restore padding removed by Starlight",
		);
	}
}

checkSourceStructure();
checkThemeContracts();
await checkGeneratedLinks();

if (errors.length > 0) {
	console.error(`Documentation validation failed with ${errors.length} error(s):`);
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log("Documentation structure and internal links are valid.");
