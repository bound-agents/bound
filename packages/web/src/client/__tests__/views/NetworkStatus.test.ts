import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// NetworkStatus loads GET /api/status/network on mount and renders a host grid
// (one card per host, each with a LineBadge, a StatusChip, version/last-seen/
// sync/error fields, and model/MCP pills), a TopologyDiagram, and a Sync Mesh
// table. It also exercises the online/health classifiers and the loading/error
// states. The children (TopologyDiagram, LineBadge, StatusChip, TicketTab,
// SectionHeader, Page) all render through this view.

const dom = installDom({ url: "http://localhost/#/network" });
afterAll(() => dom.teardown());

const LOCAL_SITE = "site-local-aaaaaaaaaaaaaaaa";
const PEER_SITE = "site-peer-bbbbbbbbbbbbbbbb";
const HUB_SITE = "site-hub-cccccccccccccccc";

function nowIso(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

/** A network payload with a local node, an online hub, and a stale peer. */
function sampleNetwork() {
	return {
		localSiteId: LOCAL_SITE,
		hub: { siteId: HUB_SITE, hostName: "hub-node" },
		hosts: [
			{
				site_id: LOCAL_SITE,
				host_name: "local-node",
				version: "0.1.2",
				sync_url: null,
				online_at: nowIso(),
				models: JSON.stringify([{ id: "gpt-x" }, "haiku"]),
				mcp_tools: JSON.stringify(["github", "tavily"]),
				modified_at: nowIso(),
			},
			{
				site_id: HUB_SITE,
				host_name: "hub-node",
				version: "0.1.2",
				sync_url: "https://hub.example",
				online_at: nowIso(),
				models: null,
				mcp_tools: null,
				modified_at: nowIso(),
			},
			{
				// Stale peer: modified_at well beyond the 5-minute online threshold.
				site_id: PEER_SITE,
				host_name: "peer-node",
				version: null,
				sync_url: "https://peer.example",
				online_at: nowIso(-20 * 60 * 1000),
				models: null,
				mcp_tools: null,
				modified_at: nowIso(-20 * 60 * 1000),
			},
		],
		syncState: [
			{
				peer_site_id: HUB_SITE,
				last_received: "2026-11-19T00:00:00.000Z",
				last_sent: "2026-11-19T00:00:00.000Z",
				last_sync_at: nowIso(-30 * 1000),
				sync_errors: 0,
			},
			{
				peer_site_id: PEER_SITE,
				last_received: "2026-11-18T00:00:00.000Z",
				last_sent: "2026-11-18T00:00:00.000Z",
				last_sync_at: nowIso(-20 * 60 * 1000),
				sync_errors: 3,
			},
		],
	};
}

async function mountNetwork(payload: unknown) {
	dom.route("GET", "/api/status/network", () => payload);
	const NetworkStatus = (await import("../../views/NetworkStatus.svelte")).default;
	const mounted = await dom.mount(NetworkStatus, {});
	await dom.settle();
	return mounted;
}

describe("NetworkStatus", () => {
	it("loads the network and renders one host card per host", async () => {
		const { target } = await mountNetwork(sampleNetwork());
		expect(dom.requests.some((r) => r.path === "/api/status/network")).toBe(true);
		const cards = target.querySelectorAll(".host-card");
		expect(cards.length).toBe(3);
		expect(target.textContent).toContain("local-node");
		expect(target.textContent).toContain("hub-node");
		expect(target.textContent).toContain("peer-node");
	});

	it("marks the hub card with a HUB badge", async () => {
		const { target } = await mountNetwork(sampleNetwork());
		const badges = Array.from(target.querySelectorAll(".hub-badge"));
		expect(badges.length).toBe(1);
		expect(badges[0].textContent).toBe("HUB");
	});

	it("shows the online StatusChip for the local node and offline for the stale peer", async () => {
		const { target } = await mountNetwork(sampleNetwork());
		const chips = Array.from(target.querySelectorAll(".status-chip .label")).map(
			(el) => el.textContent,
		);
		// StatusChip renders "Online"/"Offline" labels (child component coverage).
		expect(chips).toContain("Online");
		expect(chips).toContain("Offline");
	});

	it("renders model and MCP-tool pills from the JSON columns", async () => {
		const { target } = await mountNetwork(sampleNetwork());
		const pills = Array.from(target.querySelectorAll(".pill")).map((el) => el.textContent?.trim());
		expect(pills).toContain("gpt-x");
		expect(pills).toContain("haiku");
		expect(pills).toContain("github");
		expect(pills).toContain("tavily");
	});

	it("renders the Sync Mesh table sorted by peer name with the error count surfaced", async () => {
		const { target } = await mountNetwork(sampleNetwork());
		expect(target.textContent).toContain("Sync Mesh");
		const rows = Array.from(target.querySelectorAll(".mesh-row"));
		expect(rows.length).toBe(2);
		// Rows sort by peer host_name: "hub-node" before "peer-node".
		const peerNames = rows.map((r) => r.querySelector(".peer")?.textContent);
		expect(peerNames).toEqual(["hub-node", "peer-node"]);
		// The peer with 3 sync_errors shows that count.
		expect(target.textContent).toContain("3");
	});

	it("renders the TopologyDiagram with the hub in the center and a peer orbit", async () => {
		const { target } = await mountNetwork(sampleNetwork());
		const svg = target.querySelector(".topology-svg");
		expect(svg).not.toBeNull();
		// Hub center label + peer online/offline labels come from TopologyDiagram.
		expect(svg?.textContent).toContain("HUB");
		expect(svg?.textContent).toContain("hub-node");
		expect(svg?.textContent).toContain("ONLINE");
		expect(svg?.textContent).toContain("OFFLINE");
	});

	it("degrades a peer with sync errors inside the 10-minute window", async () => {
		// last_sync_at recent (<5m) but sync_errors > 0 → "degraded".
		const payload = sampleNetwork();
		payload.syncState = [
			{
				peer_site_id: PEER_SITE,
				last_received: "x",
				last_sent: "x",
				last_sync_at: nowIso(-30 * 1000),
				sync_errors: 2,
			},
		];
		// Make the peer itself online so the card isn't forced to the offline color.
		payload.hosts[2].modified_at = nowIso();
		payload.hosts[2].online_at = nowIso();
		const { target } = await mountNetwork(payload);
		expect(target.textContent).toContain("DEGRADED");
	});

	it("shows the error state when the network request fails", async () => {
		dom.route("GET", "/api/status/network", () => new Response("nope", { status: 500 }));
		const NetworkStatus = (await import("../../views/NetworkStatus.svelte")).default;
		const { target } = await dom.mount(NetworkStatus, {});
		await dom.settle();
		expect(target.querySelector(".state.err")).not.toBeNull();
		expect(target.textContent).toContain("Failed to load network status");
	});
});
