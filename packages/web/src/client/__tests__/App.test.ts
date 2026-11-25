import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { __resetMcpAppsForTests } from "../lib/mcp-apps-bootstrap";
import { installDom } from "./harness/dom";

// App is the hash-router shell: it mounts TopBar, resolves the current hash to
// a view, redirects two legacy hashes, derives a `data-screen-label` from the
// route, and swaps the mounted view on `hashchange`. Each view fetches on
// mount, so the harness fakes every endpoint the reachable views touch; the
// assertions key off `data-screen-label` (set by App.screenLabel) plus a
// view-specific DOM marker so we prove the *right* child mounted, not just that
// something rendered. One shared harness window for the file (svelte caches the
// first window process-wide); teardown restores globals so later files are clean.

const dom = installDom({ url: "http://localhost/#/" });
afterAll(() => dom.teardown());

afterEach(() => {
	// App.svelte's onMount fires `void initMcpApps()`, which latches the
	// module-level `started` flag process-wide; a LATER file's bootstrap test
	// expects to be the first caller, so clear the latch here.
	__resetMcpAppsForTests();
});

// Fakes for every endpoint a reachable view hits on mount. Returning minimal
// but shape-valid payloads keeps each view from throwing during its onMount
// fetch (an unhandled rejection there would leak into later files).
function installRoutes() {
	// SystemMap: thread directory page.
	// listThreadsPage reads res.json() as a bare ThreadListEntry[]; the total
	// comes from the X-Total-Count header (absent here → falls back to length).
	// Match the exact directory path only, not /api/threads/<id>[/status|/messages]:
	// installRoutes() runs inside mountApp AFTER a test's per-route /line fakes, and
	// a broad /\/api\/threads/ would shadow them (later registration wins).
	dom.route("GET", "/api/threads", () => []);
	// TopBar: advisory count badge poll.
	dom.route("GET", "/api/advisories/count", () => ({ count: 0 }));
	// AdvisoryView: listAdvisories returns a bare array; getNetwork hits
	// /api/status/network and NetworkStatus iterates .hosts and .syncState.
	dom.route("GET", /\/api\/advisories/, () => []);
	dom.route("GET", "/api/status/network", () => ({
		hosts: [],
		hub: null,
		syncState: [],
		localSiteId: "local",
	}));
	dom.route("GET", /\/api\/status\/models/, () => ({ models: [], default: "" }));
	// FilesView: listFiles returns a bare array.
	dom.route("GET", /\/api\/files/, () => []);
	// Timetable: listTasks returns a bare array.
	dom.route("GET", /\/api\/tasks/, () => []);
	// PersonaView: reads data.max_bytes off the payload.
	dom.route("GET", "/api/persona", () => ({
		persona: "",
		modified_at: null,
		max_bytes: 65536,
	}));
	// LineView mounts McpChallengeCard, which fetches /api/mcp-challenges and
	// reads data.challenges.length.
	dom.route("GET", "/api/mcp-challenges", () => ({
		challenges: [],
		loopback: false,
		canResolve: false,
	}));
	// WebhookView: listWebhooks returns a bare array; the kill-switch read
	// returns { allow_unauthenticated }.
	dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
		allow_unauthenticated: false,
	}));
	dom.route("GET", /\/api\/webhooks/, () => []);
	// RSS, connectors, skills, mcp sub-views under Connections.
	// listRssFeeds hits /api/rss-feeds and returns a bare array.
	dom.route("GET", /\/api\/rss-feeds/, () => []);
	// listConnectorBindings reads response.bindings; the view also calls
	// listModels (/api/status/models, faked above).
	dom.route("GET", /\/api\/connectors/, () => ({ bindings: [] }));
	// listSkills returns a bare array.
	dom.route("GET", /\/api\/skills/, () => []);
	// McpServersView reads body.servers.
	dom.route("GET", /\/api\/mcp\/servers/, () => ({ servers: [] }));
	// MCP apps bootstrap (fired from onMount via initMcpApps).
	dom.route("GET", "/api/mcp-apps", () => ({ servers: [] }));
	// MetricsView reads nested `.totals` off the metrics payload; a bare {} makes
	// it throw during the mount flush. Supply a shape-valid zeroed response.
	dom.route("GET", /\/api\/metrics/, () => ({
		tokens: {
			byModel: [],
			costByModelTimeline: [],
			byProvider: [],
			totals: {
				tokens_in: 0,
				tokens_out: 0,
				cache_read: 0,
				cache_write: 0,
				cost_usd: 0,
				turn_count: 0,
				error_count: 0,
			},
		},
		relay: {
			byHost: [],
			recentCycles: [],
			totals: { total_cycles: 0, success_rate: 0, avg_latency_ms: 0, expired_count: 0 },
		},
		context: {
			totals: {
				last_cache_hit_rate: 0,
				budget_pressure_count: 0,
				avg_truncated_messages: 0,
				total_turns_with_debug: 0,
			},
			timeline: [],
		},
	}));
}

// Each test mounts a fresh App. The previous App must be unmounted first: it
// keeps a `hashchange` listener on the shared window, so leaving it live would
// let a later test's navigate() re-render a stale container and bleed its route
// label into the assertion.
let active: { unmount: () => void } | null = null;

async function mountApp(hash: string) {
	if (active) {
		active.unmount();
		active = null;
	}
	dom.window.location.hash = hash;
	installRoutes();
	const App = (await import("../App.svelte")).default;
	const mounted = await dom.mount(App, {});
	active = mounted;
	await dom.settle();
	return mounted;
}

function label(target: HTMLElement): string | null {
	return target.querySelector(".container")?.getAttribute("data-screen-label") ?? null;
}

describe("App hash router", () => {
	it("renders the System Map at the root hash", async () => {
		const { target } = await mountApp("#/");
		expect(label(target)).toBe("01 System Map");
		// SystemMap's distinctive directory header.
		expect(target.textContent).toContain("Directory");
		expect(target.textContent).toContain("Active Lines");
		// TopBar is always mounted in the shell.
		expect(target.querySelector("header.top-bar")).not.toBeNull();
		// First mount in the process pays svelte's one-time runtime init on top of
		// SystemMap's own mount, which exceeds the 5s default once.
	}, 20000);

	it("treats an empty hash as the root route", async () => {
		const { target } = await mountApp("");
		expect(label(target)).toBe("01 System Map");
		expect(target.textContent).toContain("Directory");
	});

	it("routes /line/<id> to the Line view keyed by thread id", async () => {
		// LineView fetches the thread, its status, and messages on mount.
		// getThreadStatus runs the payload through threadStatusSchema (zod), which
		// requires all five fields; a bare { active } throws and strands `thread`.
		dom.route("GET", /\/api\/threads\/[^/]+\/status$/, () => ({
			active: false,
			state: null,
			detail: null,
			tokens: 0,
			model: null,
		}));
		// listMessages reads res.json() as a bare Message[]; reconcileYardExecutions
		// and the user/assistant filters iterate it directly.
		dom.route("GET", /\/api\/threads\/[^/]+\/messages/, () => []);
		dom.route("GET", /\/api\/threads\/[^/]+$/, () => ({
			id: "abc123",
			title: "Line Thread",
			summary: null,
			color: 1,
			last_message_at: new Date().toISOString(),
			created_at: new Date().toISOString(),
		}));
		const { target } = await mountApp("#/line/abc123");
		expect(label(target)).toBe("02 Line");
		// A thread fetch for the routed id proves the /line/ branch mounted LineView
		// keyed to that id (App.svelte {#key lineRoute.threadId}).
		expect(dom.requests.some((r) => r.path.includes("/api/threads/abc123"))).toBe(true);
	});

	it("routes /timetable to the Timetable view", async () => {
		const { target } = await mountApp("#/timetable");
		expect(label(target)).toBe("03 Timetable");
	});

	it("routes /network to the Network view", async () => {
		const { target } = await mountApp("#/network");
		expect(label(target)).toBe("04 Network");
	});

	it("routes /advisories to the Advisory view", async () => {
		const { target } = await mountApp("#/advisories");
		expect(label(target)).toBe("05 Advisories");
	});

	it("routes /files to the Files view", async () => {
		const { target } = await mountApp("#/files");
		expect(label(target)).toBe("06 Files");
	});

	it("routes a bare /connections hash to the Connections view (webhooks default)", async () => {
		const { target } = await mountApp("#/connections");
		expect(label(target)).toBe("07 Connections");
	});

	it("routes each /connections subsection hash to the Connections view", async () => {
		// App.svelte maps the sub-path onto ConnectionsView's `section` prop; the
		// screen label stays "07 Connections" for every subsection. Exercising all
		// five walks the nested ternary that picks the section.
		for (const sub of [
			"/connections/skills",
			"/connections/mcp",
			"/connections/connectors",
			"/connections/rss",
			"/connections/webhooks",
		]) {
			const { target } = await mountApp(`#${sub}`);
			expect(label(target)).toBe("07 Connections");
		}
	});

	it("routes /metrics to the Metrics view", async () => {
		const { target } = await mountApp("#/metrics");
		expect(label(target)).toBe("08 Metrics");
	});

	it("routes /persona to the Persona view", async () => {
		const { target } = await mountApp("#/persona");
		expect(label(target)).toBe("08 Persona");
	});

	it("falls back to the System Map for an unknown hash", async () => {
		const { target } = await mountApp("#/does-not-exist");
		// Unknown routes label as such but still render the SystemMap fallback.
		expect(label(target)).toBe("00 Unknown");
		expect(target.textContent).toContain("Directory");
	});

	it("redirects the legacy /webhooks hash onto the Connections view", async () => {
		// currentRoute() redirects /webhooks -> /connections/webhooks and returns
		// the target, so the resolved screen label is Connections, not Unknown.
		const { target } = await mountApp("#/webhooks");
		expect(label(target)).toBe("07 Connections");
	});

	it("redirects the legacy /skills hash onto the Connections view", async () => {
		const { target } = await mountApp("#/skills");
		expect(label(target)).toBe("07 Connections");
	});

	it("swaps the mounted view when the hash changes after mount", async () => {
		const { target } = await mountApp("#/");
		expect(label(target)).toBe("01 System Map");
		await dom.navigate("#/metrics");
		expect(label(target)).toBe("08 Metrics");
		// And back to the map.
		await dom.navigate("#/");
		expect(label(target)).toBe("01 System Map");
		expect(target.textContent).toContain("Directory");
	});
});
