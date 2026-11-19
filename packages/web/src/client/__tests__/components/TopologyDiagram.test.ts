import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

type Host = {
	site_id: string;
	host_name: string;
	version?: string | null;
	online_at?: string | null;
	modified_at?: string | null;
};
type Health = "healthy" | "degraded" | "unreachable" | "unknown";

async function mount(props: {
	hosts: Host[];
	hub: { siteId: string; hostName: string } | null;
	syncHealth: Map<string, Health>;
	localSiteId?: string;
}) {
	dom = installDom();
	const TopologyDiagram = (await import("../../components/TopologyDiagram.svelte")).default;
	const mounted = await dom.mount(TopologyDiagram, props);
	await dom.settle();
	return mounted;
}

const nowIso = () => new Date().toISOString();
const staleIso = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

describe("TopologyDiagram", () => {
	it("renders the hub in the center with its name and version", async () => {
		const { target } = await mount({
			hosts: [{ site_id: "hub-1", host_name: "polaris", version: "v1.2.3", modified_at: nowIso() }],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map(),
		});
		expect(target.textContent).toContain("HUB");
		expect(target.textContent).toContain("polaris");
		expect(target.textContent).toContain("v1.2.3");
	});

	it("omits the hub version line when no version is set", async () => {
		const { target } = await mount({
			hosts: [{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() }],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map(),
		});
		expect(target.textContent).toContain("polaris");
		expect(target.textContent).not.toContain("v1.");
	});

	it("renders peers orbiting the hub, each with its host name", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "spoke-1", host_name: "alpha", modified_at: nowIso() },
				{ site_id: "spoke-2", host_name: "beta", modified_at: nowIso() },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map([
				["spoke-1", "healthy"],
				["spoke-2", "unreachable"],
			]),
		});
		expect(target.textContent).toContain("alpha");
		expect(target.textContent).toContain("beta");
		// Each peer gets an ONLINE/OFFLINE marker.
		expect(target.textContent).toMatch(/ONLINE|OFFLINE/);
	});

	it("marks a recently-modified peer ONLINE and a stale one OFFLINE", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "spoke-fresh", host_name: "fresh", modified_at: nowIso() },
				{ site_id: "spoke-stale", host_name: "stale", modified_at: staleIso() },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map([
				["spoke-fresh", "healthy"],
				["spoke-stale", "unreachable"],
			]),
		});
		expect(target.textContent).toContain("ONLINE");
		expect(target.textContent).toContain("OFFLINE");
	});

	it("treats the local site as always online even without a timestamp", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "me", host_name: "localhost", modified_at: null, online_at: null },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map([["me", "healthy"]]),
			localSiteId: "me",
		});
		// The local peer renders ONLINE despite null timestamps.
		expect(target.textContent).toContain("localhost");
		expect(target.textContent).toContain("ONLINE");
	});

	it("renders an animated pulse dot only for healthy online edges", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "spoke-1", host_name: "alpha", modified_at: nowIso() },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map([["spoke-1", "healthy"]]),
		});
		// animateMotion appears on the healthy edge's pulse dot.
		expect(target.querySelector("animateMotion")).not.toBeNull();
	});

	it("renders no pulse dot for an unreachable edge (dashed spoke)", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "spoke-1", host_name: "alpha", modified_at: nowIso() },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map([["spoke-1", "unreachable"]]),
		});
		expect(target.querySelector("animateMotion")).toBeNull();
		// The spoke line uses a dashed stroke for unreachable.
		const lines = [...target.querySelectorAll("line")];
		expect(lines.some((l) => l.getAttribute("stroke-dasharray") === "6 6")).toBe(true);
	});

	it("renders with no hub (hubHost null) when hub is not in the host list", async () => {
		const { target } = await mount({
			hosts: [{ site_id: "spoke-1", host_name: "alpha", modified_at: nowIso() }],
			hub: null,
			syncHealth: new Map([["spoke-1", "degraded"]]),
		});
		// No HUB label (hubHost is null), but the peer still renders.
		expect(target.textContent).not.toContain("HUB");
		expect(target.textContent).toContain("alpha");
	});

	it("colors a degraded link distinctly (warn), exercising linkColor's degraded branch", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "spoke-1", host_name: "alpha", modified_at: nowIso() },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map([["spoke-1", "degraded"]]),
		});
		const lines = [...target.querySelectorAll("line")];
		expect(lines.some((l) => l.getAttribute("stroke") === "var(--warn)")).toBe(true);
	});

	it("falls back to the unknown link color when a peer has no health entry", async () => {
		const { target } = await mount({
			hosts: [
				{ site_id: "hub-1", host_name: "polaris", modified_at: nowIso() },
				{ site_id: "spoke-1", host_name: "alpha", modified_at: nowIso() },
			],
			hub: { siteId: "hub-1", hostName: "polaris" },
			syncHealth: new Map(),
		});
		const lines = [...target.querySelectorAll("line")];
		expect(lines.some((l) => l.getAttribute("stroke") === "var(--ink-4)")).toBe(true);
	});
});
