import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ConnectionsView: a split view with a left sub-nav of five sections and a
// right content pane that renders exactly one child view per `section` prop.
// These tests assert the sub-nav links (label, desc, href, active/aria-current
// marking) and that the content pane switches to the right child view for each
// section. Child views fetch their lists on mount, so every endpoint they call
// is routed to empty data; the assertions key on each child's distinct chrome.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

function routeChildEndpoints() {
	// Every child view lists something on mount; empty responses let them render
	// their empty state without 404 noise.
	dom.route("GET", "/api/skills", () => []);
	dom.route("GET", "/api/webhooks", () => []);
	dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({ enabled: false }));
	dom.route("GET", "/api/rss-feeds", () => []);
	dom.route("GET", "/api/connectors/bindings", () => ({ bindings: [] }));
	dom.route("GET", "/api/status/models", () => ({ models: [], default: "" }));
	dom.route("GET", "/api/mcp/servers", () => ({ servers: [] }));
	dom.route("GET", "/api/mcp-challenges/by-server", () => ({
		servers: {},
		loopback: false,
		canResolve: false,
	}));
}

async function mountView(section: string) {
	const ConnectionsView = (await import("../../views/ConnectionsView.svelte")).default;
	const handle = await dom.mount(ConnectionsView, { section });
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

describe("ConnectionsView", () => {
	beforeEach(() => {
		routeChildEndpoints();
	});

	it("renders all five sub-nav sections with labels, descriptions, and hrefs", async () => {
		const { target } = await mountView("webhooks");
		const links = target.querySelectorAll(".sub-link");
		expect(links.length).toBe(5);
		const labels = Array.from(target.querySelectorAll(".sub-label")).map((n) => n.textContent);
		expect(labels).toEqual([
			"Webhooks",
			"RSS feeds",
			"Connector bindings",
			"Skills",
			"MCP Servers",
		]);
		expect(target.querySelector(".sub-desc")?.textContent).toBe("Automated messaging endpoints");
		// Hrefs drive the hash router.
		const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
		expect(hrefs).toContain("#/connections/rss");
		expect(hrefs).toContain("#/connections/mcp");
	});

	it("marks the active section with the active class and aria-current", async () => {
		const { target } = await mountView("skills");
		const active = target.querySelector(".sub-link.active") as HTMLAnchorElement;
		expect(active).not.toBeNull();
		expect(active.querySelector(".sub-label")?.textContent).toBe("Skills");
		expect(active.getAttribute("aria-current")).toBe("page");
		// Only one link is active; the others carry no aria-current.
		expect(target.querySelectorAll(".sub-link.active").length).toBe(1);
		expect(target.querySelectorAll('.sub-link[aria-current="page"]').length).toBe(1);
	});

	it("renders the webhooks child view by default (unmatched section falls through)", async () => {
		const { target } = await mountView("webhooks");
		// WebhookView is the else branch; its content lands in the pane.
		expect(target.querySelector(".content")).not.toBeNull();
		expect(target.textContent?.toLowerCase()).toContain("webhook");
	});

	it("switches the content pane to the Skills child view", async () => {
		const { target } = await mountView("skills");
		expect(target.textContent?.toLowerCase()).toContain("skill");
	});

	it("switches the content pane to the RSS child view", async () => {
		const { target } = await mountView("rss");
		const text = target.textContent?.toLowerCase() ?? "";
		expect(text).toContain("rss");
	});

	it("switches the content pane to the Connector bindings child view", async () => {
		const { target } = await mountView("connectors");
		const text = target.textContent?.toLowerCase() ?? "";
		expect(text).toContain("connector");
	});

	it("switches the content pane to the MCP Servers child view", async () => {
		const { target } = await mountView("mcp");
		const text = target.textContent?.toLowerCase() ?? "";
		expect(text).toContain("mcp");
	});
});
