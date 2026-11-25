import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { Advisory } from "@bound/shared";
import { installDom } from "../harness/dom";

// AdvisoryView loads advisories (GET /api/advisories) + network hosts
// (GET /api/status/network) on mount, polls every 5s, splits into open vs
// resolved, renders markdown detail, and performs approve/dismiss/defer/apply
// actions (each POST /api/advisories/<id>/<action> with a required note sourced
// from window.prompt).

const dom = installDom({ url: "http://localhost/#/advisories" });
afterAll(() => dom.teardown());

// window.prompt is unimplemented in jsdom; override it per test.
let promptReturn: string | null = "a note";
(dom.window as unknown as { prompt: (msg?: string) => string | null }).prompt = () => promptReturn;
// Actions take a required note through an inline input + Confirm button.
async function submitNote(target: Element, note: string): Promise<void> {
	const input = target.querySelector("input.note-input") as HTMLInputElement;
	expect(input).not.toBeNull();
	input.value = note;
	await dom.fire(input, "input");
	await dom.settle();
	const confirm = Array.from(target.querySelectorAll("button")).find((b) =>
		b.textContent?.trim().startsWith("Confirm"),
	) as HTMLButtonElement;
	await dom.fire(confirm, "click");
	await dom.settle();
}

let AdvisoryView: typeof import("../../views/AdvisoryView.svelte").default;

function adv(over: Partial<Advisory>): Advisory {
	return {
		id: "adv-00000000-1111",
		type: "info",
		status: "proposed",
		title: "Disk space low",
		detail: "Root volume at 82%.",
		action: null,
		impact: null,
		evidence: null,
		proposed_at: "2026-01-01T00:00:00.000Z",
		defer_until: null,
		resolved_at: null,
		created_by: null,
		modified_at: "2026-01-02T00:00:00.000Z",
		deleted: 0,
		thread_id: null,
		resolved_by: null,
		resolution_note: null,
		...over,
	} as Advisory;
}

function routeNetwork(hosts: { site_id: string; host_name: string }[] = []) {
	dom.route("GET", "/api/status/network", () => ({
		hosts,
		hub: null,
		syncState: [],
		localSiteId: "local",
	}));
}

beforeEach(() => {
	promptReturn = "a note";
});

async function load() {
	AdvisoryView = (await import("../../views/AdvisoryView.svelte")).default;
	return AdvisoryView;
}

describe("AdvisoryView", () => {
	it("shows loading, then renders the open advisory list", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({ id: "adv-open-1", title: "Disk space low", status: "proposed" }),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		expect(dom.requests.some((r) => r.path === "/api/advisories")).toBe(true);
		expect(dom.requests.some((r) => r.path === "/api/status/network")).toBe(true);
		expect(target.textContent).toContain("Disk space low");
		// Open count chip + section title reflect one open advisory.
		expect(target.textContent).toContain("1 open");
		expect(target.querySelector(".empty")).toBeNull();
	});

	it("renders the empty state when there are no open advisories", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => []);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		expect(target.querySelector(".empty")?.textContent).toContain("No open advisories");
		expect(target.textContent).toContain("0 open");
	});

	it("splits resolved advisories into a collapsed section that expands on click", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({ id: "adv-open", title: "Open one", status: "proposed" }),
			adv({
				id: "adv-done",
				title: "Done one",
				status: "dismissed",
				detail: "Already handled.",
			}),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		// Resolved toggle present, resolved list collapsed initially.
		const toggle = target.querySelector(".resolved-toggle") as HTMLButtonElement;
		expect(toggle).not.toBeNull();
		expect(toggle.textContent).toContain("Resolved · 1");
		expect(target.querySelector(".resolved-list")).toBeNull();
		await dom.fire(toggle, "click");
		expect(target.querySelector(".resolved-list")).not.toBeNull();
		expect(target.querySelector(".resolved-list")?.textContent).toContain("Done one");
	});

	it("toggles a card body open and renders markdown-rendered detail", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({
				id: "adv-md",
				title: "Markdown advisory",
				status: "proposed",
				detail: "# Heading\n\nbody paragraph",
				impact: "Users affected",
			}),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		expect(target.querySelector(".adv-body")).toBeNull();
		const head = target.querySelector(".adv-head") as HTMLButtonElement;
		await dom.fire(head, "click");
		await dom.settle();
		const body = target.querySelector(".adv-body");
		expect(body).not.toBeNull();
		// renderMarkdown resolves async; the md-content block appears after settle.
		const md = target.querySelector(".md-content");
		expect(md?.querySelector("h1")?.textContent).toContain("Heading");
		expect(body?.textContent).toContain("Users affected");
	});

	it("approves an advisory: takes an inline note and POSTs to the approve endpoint", async () => {
		routeNetwork();
		let listCalls = 0;
		dom.route("GET", "/api/advisories", () => {
			listCalls++;
			// First load proposed; after approve-reload it's approved.
			return [
				adv({
					id: "adv-act",
					title: "Act on me",
					status: listCalls === 1 ? "proposed" : "approved",
				}),
			];
		});
		dom.route("POST", /\/api\/advisories\/[^/]+\/approve/, (req) => {
			expect(req.body).toEqual({ note: "a note" });
			return adv({ id: "adv-act", status: "approved" });
		});
		promptReturn = "a note";
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		const head = target.querySelector(".adv-head") as HTMLButtonElement;
		await dom.fire(head, "click");
		await dom.settle();
		// Find the Approve button in the expanded action bar.
		const approveBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Approve",
		) as HTMLButtonElement;
		expect(approveBtn).not.toBeUndefined();
		await dom.fire(approveBtn, "click");
		await dom.settle();
		await submitNote(target, "a note");
		expect(dom.requests.some((r) => r.method === "POST" && r.path.endsWith("/approve"))).toBe(true);
		// After approve, the advisory reloads as approved and shows the Apply button.
		const applyBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Apply",
		);
		expect(applyBtn).not.toBeUndefined();
	});

	it("aborts an action when the inline note is cancelled (no POST)", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({ id: "adv-cancel", title: "Cancel me", status: "proposed" }),
		]);
		dom.route("POST", /\/api\/advisories\//, () => adv({ id: "adv-cancel" }));
		promptReturn = null; // user cancels the prompt
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		const head = target.querySelector(".adv-head") as HTMLButtonElement;
		await dom.fire(head, "click");
		await dom.settle();
		const dismissBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Dismiss",
		) as HTMLButtonElement;
		// dom.requests accumulates across tests; count only POSTs after this point.
		const postsBefore = dom.requests.filter((r) => r.method === "POST").length;
		await dom.fire(dismissBtn, "click");
		await dom.settle();
		const cancel = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Cancel",
		) as HTMLButtonElement;
		await dom.fire(cancel, "click");
		await dom.settle();
		expect(target.querySelector("input.note-input")).toBeNull();
		const postsAfter = dom.requests.filter((r) => r.method === "POST").length;
		expect(postsAfter).toBe(postsBefore);
	});

	it("maps a warn-type advisory to the Service Advisory label", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({ id: "adv-warn", type: "warn", title: "Hot node", status: "proposed" }),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		expect(target.querySelector(".adv-card .kicker")?.textContent).toContain("Service Advisory");
	});

	it("resolves host labels from the network status map", async () => {
		routeNetwork([{ site_id: "site-abc", host_name: "polaris-hub" }]);
		dom.route("GET", "/api/advisories", () => [
			adv({ id: "adv-host", title: "From hub", created_by: "site-abc", status: "proposed" }),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		expect(target.textContent).toContain("from polaris-hub");
	});

	it("changes sort order through the select", async () => {
		routeNetwork();
		const older = adv({
			id: "adv-older",
			title: "Older",
			status: "proposed",
			modified_at: "2026-01-01T00:00:00.000Z",
		});
		const newer = adv({
			id: "adv-newer",
			title: "Newer",
			status: "proposed",
			modified_at: "2026-02-01T00:00:00.000Z",
		});
		dom.route("GET", "/api/advisories", () => [older, newer]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		const titlesDesc = Array.from(target.querySelectorAll(".adv-title")).map((e) =>
			e.textContent?.trim(),
		);
		// Default modified-desc: Newer first.
		expect(titlesDesc[0]).toBe("Newer");
		const select = target.querySelector("select") as HTMLSelectElement;
		await dom.type(select, "modified-asc");
		await dom.settle();
		const titlesAsc = Array.from(target.querySelectorAll(".adv-title")).map((e) =>
			e.textContent?.trim(),
		);
		expect(titlesAsc[0]).toBe("Older");
	});

	it("navigates to the originating thread when the source link is clicked", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({
				id: "adv-thread",
				title: "Has source",
				status: "proposed",
				thread_id: "thread-xyz",
			}),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		const head = target.querySelector(".adv-head") as HTMLButtonElement;
		await dom.fire(head, "click");
		await dom.settle();
		const link = target.querySelector(".thread-link") as HTMLButtonElement;
		expect(link).not.toBeNull();
		await dom.fire(link, "click");
		await dom.settle();
		// navigateTo sets the hash route.
		expect(dom.window.location.hash).toContain("/line/thread-xyz");
	});

	it("keeps rendering when the advisories fetch rejects", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => {
			return new Response(JSON.stringify({ error: "db down" }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		});
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		// A failed fetch shows an inline error, not the "Systems nominal" empty state.
		expect(target.textContent).toContain("Failed to load advisories");
		expect(target.querySelector(".empty")).toBeNull();
	});

	it("renders detail + evidence for an expanded resolved advisory", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({
				id: "adv-resolved-detail",
				title: "Resolved with detail",
				status: "applied",
				detail: "What happened here.",
				evidence: "log line 1\nlog line 2",
			}),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		// Expand the resolved section, then the card inside it.
		const toggle = target.querySelector(".resolved-toggle") as HTMLButtonElement;
		await dom.fire(toggle, "click");
		await dom.settle();
		const head = target.querySelector(".resolved-list .adv-head") as HTMLButtonElement;
		expect(head).not.toBeNull();
		await dom.fire(head, "click");
		await dom.settle();
		const body = target.querySelector(".resolved-list .adv-body");
		expect(body).not.toBeNull();
		expect(target.querySelector(".resolved-list .evidence")?.textContent).toContain("log line 1");
	});

	it("applies an approved advisory via the apply endpoint", async () => {
		routeNetwork();
		let listCalls = 0;
		dom.route("GET", "/api/advisories", () => {
			listCalls++;
			return [
				adv({
					id: "adv-apply",
					title: "Approved item",
					status: listCalls === 1 ? "approved" : "applied",
				}),
			];
		});
		dom.route("POST", /\/api\/advisories\/[^/]+\/apply/, (req) => {
			expect(req.body).toEqual({ note: "a note" });
			return adv({ id: "adv-apply", status: "applied" });
		});
		promptReturn = "a note";
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		const head = target.querySelector(".adv-head") as HTMLButtonElement;
		await dom.fire(head, "click");
		await dom.settle();
		const applyBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Apply",
		) as HTMLButtonElement;
		expect(applyBtn).not.toBeUndefined();
		await dom.fire(applyBtn, "click");
		await dom.settle();
		await submitNote(target, "a note");
		expect(dom.requests.some((r) => r.method === "POST" && r.path.endsWith("/apply"))).toBe(true);
	});

	it("defers a proposed advisory via the defer endpoint", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({ id: "adv-defer", title: "Defer me", status: "proposed" }),
		]);
		dom.route("POST", /\/api\/advisories\/[^/]+\/defer/, () =>
			adv({ id: "adv-defer", status: "deferred" }),
		);
		promptReturn = "later please";
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		const head = target.querySelector(".adv-head") as HTMLButtonElement;
		await dom.fire(head, "click");
		await dom.settle();
		const deferBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Defer",
		) as HTMLButtonElement;
		const postsBefore = dom.requests.filter((r) => r.method === "POST").length;
		await dom.fire(deferBtn, "click");
		await dom.settle();
		await submitNote(target, "later please");
		const deferPost = dom.requests
			.slice(postsBefore)
			.find((r) => r.method === "POST" && r.path.endsWith("/defer"));
		expect(deferPost?.body).toEqual({ note: "later please" });
	});

	it("falls back to a sliced site id when no host name is known", async () => {
		routeNetwork();
		dom.route("GET", "/api/advisories", () => [
			adv({
				id: "adv-unknown-host",
				title: "Mystery origin",
				created_by: "0123456789abcdef",
				status: "proposed",
			}),
		]);
		const Comp = await load();
		const { target } = await dom.mount(Comp, {});
		await dom.settle();
		// No matching host in the map: falls back to the first 10 chars of the id.
		expect(target.textContent).toContain("from 0123456789");
	});
});
