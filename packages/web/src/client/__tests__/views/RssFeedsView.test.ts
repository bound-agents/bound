import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ClusterModelInfo, RssFeedListEntry } from "@bound/client";
import { installDom } from "../harness/dom";

const dom = installDom();
afterAll(() => dom.teardown());

/** Query a required element; throws (rather than returning null) so tests read
 * without non-null assertions. */
function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`no element for selector: ${selector}`);
	return el;
}

/** Find a required <button> by predicate; throws if none matches. */
function findButton(
	root: ParentNode,
	predicate: (b: HTMLButtonElement) => boolean | undefined,
): HTMLButtonElement {
	const btn = [...root.querySelectorAll("button")].find(predicate);
	if (!btn) throw new Error("no matching button");
	return btn;
}

/** The last <form> under root; throws if there are none. */
function lastForm(root: ParentNode): HTMLFormElement {
	const form = [...root.querySelectorAll("form")].at(-1);
	if (!form) throw new Error("no form present");
	return form;
}

// RssFeedsView reaches the server through the shared BoundClient in lib/bound.ts,
// which issues relative-path fetches. The harness fakes fetch via its route
// table; these tests assert on what the operator sees and what is sent.
const RssFeedsView = (await import("../../views/RssFeedsView.svelte")).default;

function makeFeed(over: Partial<RssFeedListEntry> = {}): RssFeedListEntry {
	return {
		id: "feed-1",
		name: "hn-frontpage",
		url: "https://news.ycombinator.com/rss",
		description: "Front page",
		poll_interval_seconds: 900,
		task_id: "task-1",
		thread_id: "thread-1",
		created_at: "2026-01-02T00:00:00.000Z",
		modified_at: "2026-01-03T00:00:00.000Z",
		prompt: null,
		model_hint: null,
		no_history: false,
		...over,
	};
}

const MODELS: ClusterModelInfo[] = [
	{ id: "opus", host: "local", via: "local", status: "online" } as ClusterModelInfo,
	{ id: "glm-5", host: "msi", via: "relay", status: "offline?" } as ClusterModelInfo,
];

function baseRoutes(feeds: RssFeedListEntry[]): void {
	dom.route("GET", "/api/rss-feeds", () => feeds);
	dom.route("GET", "/api/status/models", () => ({ models: MODELS, default: "opus" }));
}

beforeEach(() => {
	dom.requests.length = 0;
	globalThis.confirm = () => true;
});

describe("RssFeedsView — list", () => {
	it("loads and renders feeds with formatted interval and active count", async () => {
		baseRoutes([
			makeFeed(),
			makeFeed({ id: "feed-2", name: "weekly", poll_interval_seconds: 3600 }),
		]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();

		expect(target.textContent).toContain("hn-frontpage");
		expect(target.textContent).toContain("weekly");
		expect(target.textContent).toContain("RSS Feeds · 2");
		expect(target.textContent).toContain("2 active");
		// 900s → "15m", 3600s → "1h".
		expect(target.textContent).toContain("15m");
		expect(target.textContent).toContain("1h");

		const paths = dom.requests.map((r) => r.path);
		expect(paths).toContain("/api/rss-feeds");
		expect(paths).toContain("/api/status/models");
		unmount();
	});

	it("formats a sub-minute interval in seconds", async () => {
		baseRoutes([makeFeed({ poll_interval_seconds: 90 })]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		expect(target.textContent).toContain("90s");
		unmount();
	});

	it("shows the empty state when there are no feeds", async () => {
		baseRoutes([]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		expect(target.textContent).toContain("No RSS feeds configured yet.");
		expect(target.textContent).toContain("RSS Feeds · 0");
		unmount();
	});

	it("renders a dismissable error banner when the list load fails", async () => {
		dom.route("GET", "/api/rss-feeds", () => new Response("boom", { status: 500 }));
		dom.route("GET", "/api/status/models", () => ({ models: [], default: "" }));
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();

		expect(target.querySelector(".error-banner")).not.toBeNull();
		const dismiss = q<HTMLButtonElement>(target, ".dismiss-btn");
		await dom.fire(dismiss, "click");
		expect(target.querySelector(".error-banner")).toBeNull();
		unmount();
	});

	it("tolerates a failed models load (best-effort dropdown)", async () => {
		dom.route("GET", "/api/rss-feeds", () => [makeFeed()]);
		dom.route("GET", "/api/status/models", () => new Response("err", { status: 500 }));
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		expect(target.textContent).toContain("hn-frontpage");
		unmount();
	});
});

describe("RssFeedsView — create", () => {
	async function enterCreate(target: HTMLElement) {
		const newBtn = findButton(target, (b) => b.textContent?.includes("New Feed"));
		await dom.fire(newBtn, "click");
	}

	it("requires a name before sending anything", async () => {
		baseRoutes([]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		await enterCreate(target);
		expect(target.textContent).toContain("Create RSS Feed");
		await dom.fire(q(target, "form"), "submit");
		expect(target.textContent).toContain("Name is required");
		expect(dom.requests.some((r) => r.method === "POST")).toBe(false);
		unmount();
	});

	it("requires a URL when the name is present", async () => {
		baseRoutes([]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		await enterCreate(target);
		await dom.type(q<HTMLInputElement>(target, "#name"), "my-feed");
		await dom.fire(q(target, "form"), "submit");
		expect(target.textContent).toContain("Feed URL is required");
		expect(dom.requests.some((r) => r.method === "POST")).toBe(false);
		unmount();
	});

	it("creates a feed and returns to the reloaded list", async () => {
		const created = makeFeed({ id: "feed-new", name: "my-feed" });
		let listCalls = 0;
		dom.route("GET", "/api/rss-feeds", () => {
			listCalls++;
			return listCalls === 1 ? [] : [created];
		});
		dom.route("GET", "/api/status/models", () => ({ models: MODELS, default: "opus" }));
		dom.route("POST", "/api/rss-feeds", (req) => ({
			...created,
			...(req.body as Record<string, unknown>),
		}));

		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		await enterCreate(target);
		await dom.type(q<HTMLInputElement>(target, "#name"), "my-feed");
		await dom.type(q<HTMLInputElement>(target, "#url"), "https://example.com/feed.xml");
		await dom.fire(q(target, "form"), "submit");
		await dom.settle();

		const post = dom.requests.find((r) => r.method === "POST" && r.path === "/api/rss-feeds");
		expect(post).toBeTruthy();
		const body = post.body as Record<string, unknown>;
		expect(body.name).toBe("my-feed");
		expect(body.url).toBe("https://example.com/feed.xml");
		expect(body.poll_interval_seconds).toBe(900);
		// Back on the list, showing the newly created feed.
		expect(target.textContent).toContain("RSS Feeds · 1");
		expect(target.textContent).toContain("my-feed");
		unmount();
	});

	it("surfaces a create error and stays on the form", async () => {
		baseRoutes([]);
		dom.route("POST", "/api/rss-feeds", () => new Response("bad", { status: 400 }));
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		await enterCreate(target);
		await dom.type(q<HTMLInputElement>(target, "#name"), "x");
		await dom.type(q<HTMLInputElement>(target, "#url"), "https://x.test/f");
		await dom.fire(q(target, "form"), "submit");
		await dom.settle();
		expect(target.querySelector(".error-box")).not.toBeNull();
		expect(target.textContent).toContain("Create RSS Feed");
		unmount();
	});

	it("renders the model dropdown options with relay/offline suffixes", async () => {
		baseRoutes([makeFeed()]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		await enterCreate(target);
		const select = q<HTMLSelectElement>(target, "#create-model");
		const text = [...select.options].map((o) => o.textContent).join(" | ");
		expect(text).toContain("Cluster default (opus)");
		expect(text).toContain("glm-5 — msi (offline?)");
		unmount();
	});

	it("Cancel returns to the list view", async () => {
		baseRoutes([makeFeed()]);
		const { target, unmount } = await dom.mount(RssFeedsView);
		await dom.settle();
		await enterCreate(target);
		const cancel = findButton(target, (b) => b.textContent?.trim() === "Cancel");
		await dom.fire(cancel, "click");
		expect(target.textContent).toContain("RSS Feeds · 1");
		unmount();
	});
});

describe("RssFeedsView — detail", () => {
	async function openDetail(over: Partial<RssFeedListEntry> = {}) {
		const feed = makeFeed(over);
		baseRoutes([feed]);
		const mounted = await dom.mount(RssFeedsView);
		await dom.settle();
		const row = mounted.target.querySelector<HTMLElement>(".data-row");
		expect(row).not.toBeNull();
		await dom.fire(row, "click");
		await dom.settle();
		return { feed, ...mounted };
	}

	it("opens detail and pre-populates the edit form from the feed", async () => {
		const { target, unmount } = await openDetail({ description: "front page feed" });
		expect(target.textContent).toContain("hn-frontpage");
		expect(target.textContent).toContain("Feed ID");
		expect(q<HTMLInputElement>(target, "#edit-url").value).toBe("https://news.ycombinator.com/rss");
		expect(q<HTMLInputElement>(target, "#edit-description").value).toBe("front page feed");
		unmount();
	});

	it("updates the feed via PATCH with the edited URL and interval", async () => {
		const { feed, target, unmount } = await openDetail();
		dom.route("PATCH", /\/api\/rss-feeds\/[^/]+$/, () => feed);
		const editUrl = q<HTMLInputElement>(target, "#edit-url");
		await dom.type(editUrl, "https://example.com/new.xml");
		const editInterval = q<HTMLInputElement>(target, "#edit-interval");
		await dom.type(editInterval, "1800");
		const form = [...target.querySelectorAll("form")].at(-1);
		await dom.fire(form, "submit");
		await dom.settle();
		const patch = dom.requests.find((r) => r.method === "PATCH");
		expect(patch).toBeTruthy();
		const body = patch.body as Record<string, unknown>;
		expect(body.url).toBe("https://example.com/new.xml");
		expect(body.poll_interval_seconds).toBe(1800);
		unmount();
	});

	it("surfaces an update error in detail", async () => {
		const { target, unmount } = await openDetail();
		dom.route("PATCH", /\/api\/rss-feeds\/[^/]+$/, () => new Response("bad", { status: 400 }));
		const form = lastForm(target);
		await dom.fire(form, "submit");
		await dom.settle();
		expect(target.querySelector(".error-box")).not.toBeNull();
		unmount();
	});

	it("resets the edit form to the selected feed's values", async () => {
		const { target, unmount } = await openDetail();
		const editUrl = q<HTMLInputElement>(target, "#edit-url");
		await dom.type(editUrl, "https://changed.test/f");
		expect(editUrl.value).toBe("https://changed.test/f");
		const resetBtn = [...target.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Reset",
		);
		await dom.fire(resetBtn, "click");
		expect(q<HTMLInputElement>(target, "#edit-url").value).toBe("https://news.ycombinator.com/rss");
		unmount();
	});

	it("deletes the feed (confirmed) and returns to the list", async () => {
		const { target, unmount } = await openDetail();
		dom.route("DELETE", /\/api\/rss-feeds\/[^/]+$/, () => new Response(null, { status: 204 }));
		dom.route("GET", "/api/rss-feeds", () => []);
		const delBtn = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Delete"),
		);
		await dom.fire(delBtn, "click");
		await dom.settle();
		expect(dom.requests.some((r) => r.method === "DELETE")).toBe(true);
		expect(target.textContent).toContain("No RSS feeds configured yet.");
		unmount();
	});

	it("does not delete when the confirm dialog is declined", async () => {
		globalThis.confirm = () => false;
		const { target, unmount } = await openDetail();
		dom.route("DELETE", /\/api\/rss-feeds\/[^/]+$/, () => new Response(null, { status: 204 }));
		const delBtn = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Delete"),
		);
		await dom.fire(delBtn, "click");
		await dom.settle();
		expect(dom.requests.some((r) => r.method === "DELETE")).toBe(false);
		unmount();
	});

	it("surfaces a delete error when the API rejects", async () => {
		const { target, unmount } = await openDetail();
		dom.route("DELETE", /\/api\/rss-feeds\/[^/]+$/, () => new Response("bad", { status: 500 }));
		const delBtn = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Delete"),
		);
		await dom.fire(delBtn, "click");
		await dom.settle();
		expect(target.querySelector(".error-banner")).not.toBeNull();
		unmount();
	});

	it("Back returns to the list from detail", async () => {
		const { target, unmount } = await openDetail();
		const back = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Back"),
		);
		await dom.fire(back, "click");
		expect(target.textContent).toContain("RSS Feeds · 1");
		unmount();
	});
});
