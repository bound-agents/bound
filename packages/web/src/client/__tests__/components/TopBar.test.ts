import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// TopBar loads the advisory count on mount, polls it, renders a nav with an
// active-tab highlight keyed off the current hash, and shows a live clock.
// The harness fakes GET /api/advisories/count (the only request it makes).
// Hash-dependent assertions set window.location.hash before mounting rather
// than re-installing jsdom per test (the harness is one-per-file).

const dom = installDom({ url: "http://localhost/#/" });
afterAll(() => dom.teardown());

describe("TopBar", () => {
	async function mountTopBar(hash: string, count: number) {
		dom.window.location.hash = hash;
		dom.route("GET", "/api/advisories/count", () => ({ count }));
		const TopBar = (await import("../../components/TopBar.svelte")).default;
		const mounted = await dom.mount(TopBar, {});
		await dom.settle();
		return mounted;
	}

	it("loads the advisory count and renders it as a badge on the Advisories tab", async () => {
		const { target } = await mountTopBar("#/", 4);
		expect(dom.requests.some((r) => r.path === "/api/advisories/count")).toBe(true);
		// The count badge only appears when > 0.
		const badge = target.querySelector(".count .count-inner");
		expect(badge?.textContent).toBe("4");
	});

	it("omits the advisory badge when the count is zero", async () => {
		const { target } = await mountTopBar("#/", 0);
		expect(target.querySelector(".count")).toBeNull();
		// All eight nav labels still render.
		expect(target.textContent).toContain("System Map");
		expect(target.textContent).toContain("Metrics");
		expect(target.textContent).toContain("Persona");
	});

	it("marks the home tab active at the root hash", async () => {
		const { target } = await mountTopBar("#/", 0);
		const links = Array.from(target.querySelectorAll("a.nav-btn"));
		const home = links.find((a) => a.getAttribute("href") === "#/");
		expect(home?.classList.contains("active")).toBe(true);
		// A non-root tab is not active.
		const metrics = links.find((a) => a.getAttribute("href") === "#/metrics");
		expect(metrics?.classList.contains("active")).toBe(false);
	});

	it("marks a nested route active via prefix match", async () => {
		const { target } = await mountTopBar("#/network/detail", 0);
		const links = Array.from(target.querySelectorAll("a.nav-btn"));
		const network = links.find((a) => a.getAttribute("href") === "#/network");
		expect(network?.classList.contains("active")).toBe(true);
		const home = links.find((a) => a.getAttribute("href") === "#/");
		expect(home?.classList.contains("active")).toBe(false);
	});

	it("updates the active tab when the hash changes", async () => {
		const { target } = await mountTopBar("#/", 0);
		await dom.navigate("#/timetable");
		const links = Array.from(target.querySelectorAll("a.nav-btn"));
		const timetable = links.find((a) => a.getAttribute("href") === "#/timetable");
		expect(timetable?.classList.contains("active")).toBe(true);
		const home = links.find((a) => a.getAttribute("href") === "#/");
		expect(home?.classList.contains("active")).toBe(false);
	});

	it("renders a clock with a timezone kicker", async () => {
		const { target } = await mountTopBar("#/", 0);
		const clockTime = target.querySelector(".clock-time");
		// tick() runs on mount, so the clock is HH:MM:SS.
		expect(clockTime?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		expect(target.querySelector(".clock-kicker")?.textContent).toContain("Local time");
	});

	it("swallows a failed advisory-count fetch without throwing", async () => {
		dom.window.location.hash = "#/";
		// 500 response → fetchJson throws → the component's catch ignores it.
		dom.route("GET", "/api/advisories/count", () => new Response("boom", { status: 500 }));
		const TopBar = (await import("../../components/TopBar.svelte")).default;
		const { target } = await dom.mount(TopBar, {});
		await dom.settle();
		// Count stays 0, so no badge, and the component still rendered.
		expect(target.querySelector(".count")).toBeNull();
		expect(target.textContent).toContain("BOUND");
	});
});
