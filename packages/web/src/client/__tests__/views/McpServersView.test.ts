import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

type McpServerHost = {
	site_id: string;
	host_name: string;
	online_at: string | null;
	has_capability_data: boolean;
};

type McpServer = {
	name: string;
	hosts: McpServerHost[];
	serverInfo?: {
		name?: string;
		title?: string;
		version?: string;
		description?: string;
		instructions?: string;
	};
	tools: Array<{
		name: string;
		description?: string;
		annotations: Record<string, boolean>;
		uiResourceUri?: string;
	}>;
	prompts?: Array<{ name: string; description?: string }>;
	resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
	divergence: Array<{ field: string; message: string }>;
};

const host = (over: Partial<McpServerHost> = {}): McpServerHost => ({
	site_id: "site-a",
	host_name: "alpha",
	online_at: "2026-11-19T00:00:00.000Z",
	has_capability_data: true,
	...over,
});

const server = (over: Partial<McpServer> = {}): McpServer => ({
	name: "github",
	hosts: [host()],
	tools: [],
	divergence: [],
	...over,
});

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

async function mountView(
	servers: McpServer[],
	challenges: {
		servers?: Record<
			string,
			{
				challengeId: string;
				serverName: string;
				scopeDemand: string;
				failureReason: string | null;
				status: string;
			}
		>;
		loopback?: boolean;
		canResolve?: boolean;
	} = {},
) {
	dom = installDom();
	dom.route("GET", "/api/mcp/servers", () => ({ servers }));
	dom.route("GET", "/api/mcp-challenges/by-server", () => ({
		servers: challenges.servers ?? {},
		loopback: challenges.loopback ?? false,
		canResolve: challenges.canResolve ?? false,
	}));
	const Component = (await import("../../views/McpServersView.svelte")).default;
	const mounted = await dom.mount(Component, {});
	await dom.settle();
	return mounted;
}

describe("McpServersView", () => {
	it("renders the loading state before data arrives, then the empty state", async () => {
		dom = installDom();
		// Hold the servers response so the loading state is observable.
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		dom.route("GET", "/api/mcp/servers", async () => {
			await gate;
			return { servers: [] };
		});
		dom.route("GET", "/api/mcp-challenges/by-server", () => ({
			servers: {},
			loopback: false,
			canResolve: false,
		}));
		const Component = (await import("../../views/McpServersView.svelte")).default;
		const { target } = await dom.mount(Component, {});
		expect(target.textContent).toContain("Loading MCP servers…");
		release?.();
		await dom.settle();
		expect(target.textContent).toContain("No MCP servers connected anywhere in the cluster.");
	});

	it("lists servers with a capability summary and host count", async () => {
		const { target } = await mountView([
			server({
				name: "github",
				serverInfo: { name: "github", version: "1.2.0" },
				tools: [{ name: "search", annotations: {} }],
				prompts: [{ name: "p1" }],
				resources: [],
				hosts: [host(), host({ site_id: "site-b", host_name: "beta" })],
			}),
		]);
		expect(target.textContent).toContain("github");
		expect(target.textContent).toContain("1.2.0");
		// hasCapabilityData true (serverInfo present): "1 tool · 1 prompt · 0 resources · 2 hosts"
		expect(target.textContent).toContain("1 tool");
		expect(target.textContent).toContain("1 prompt");
		expect(target.textContent).toContain("0 resources");
		expect(target.textContent).toContain("2 hosts");
	});

	it("summarizes an annotated-only (partial inventory) server differently", async () => {
		const { target } = await mountView([
			server({
				name: "legacy",
				// No serverInfo/prompts/resources => hasCapabilityData false.
				tools: [
					{ name: "a", annotations: { readOnlyHint: true } },
					{ name: "b", annotations: {} },
				],
				hosts: [host({ has_capability_data: false })],
			}),
		]);
		expect(target.textContent).toContain("2 annotated tools");
		expect(target.textContent).toContain("1 host");
	});

	it("summarizes a server with no capability data and no tools", async () => {
		const { target } = await mountView([
			server({ name: "blank", tools: [], hosts: [host({ has_capability_data: false })] }),
		]);
		expect(target.textContent).toContain("no capability data");
	});

	it("expands and collapses a server's detail on row click", async () => {
		const { target } = await mountView([
			server({
				name: "github",
				serverInfo: {
					name: "github",
					title: "GitHub",
					version: "1.0",
					description: "Git host",
					instructions: "Be careful",
				},
				tools: [
					{ name: "search", description: "Search repos", annotations: { readOnlyHint: true } },
				],
				prompts: [{ name: "summarize", description: "Summarize a PR" }],
				resources: [
					{ uri: "repo://x", name: "repo", description: "A repo", mimeType: "text/plain" },
				],
			}),
		]);
		const row = target.querySelector("button.server-row");
		expect(row).toBeTruthy();
		// Detail hidden initially.
		expect(target.textContent).not.toContain("Available on");

		await dom?.fire(row as Element, "click");
		expect(target.textContent).toContain("Available on");
		expect(target.textContent).toContain("Tools");
		expect(target.textContent).toContain("search");
		expect(target.textContent).toContain("Search repos");
		expect(target.textContent).toContain("read-only");
		expect(target.textContent).toContain("Prompts");
		expect(target.textContent).toContain("summarize");
		expect(target.textContent).toContain("Resources");
		expect(target.textContent).toContain("repo://x");
		// serverInfo block.
		expect(target.textContent).toContain("GitHub");
		expect(target.textContent).toContain("Git host");
		expect(target.textContent).toContain("Instructions to agents");

		// Collapse again.
		await dom?.fire(row as Element, "click");
		expect(target.textContent).not.toContain("Available on");
	});

	it("renders all annotation chip polarities", async () => {
		const { target } = await mountView([
			server({
				name: "tools",
				serverInfo: { name: "tools" },
				tools: [
					{
						name: "writer",
						annotations: {
							readOnlyHint: false,
							destructiveHint: true,
							idempotentHint: false,
						},
					},
					{
						name: "reader",
						annotations: {
							readOnlyHint: true,
							destructiveHint: false,
							idempotentHint: true,
						},
						uiResourceUri: "ui://panel",
					},
				],
				prompts: [],
				resources: [],
			}),
		]);
		await dom?.fire(target.querySelector("button.server-row") as Element, "click");
		const text = target.textContent ?? "";
		expect(text).toContain("writes");
		expect(text).toContain("destructive");
		expect(text).toContain("non-idempotent");
		expect(text).toContain("read-only");
		expect(text).toContain("non-destructive");
		expect(text).toContain("idempotent");
		expect(text).toContain("MCP App");
	});

	it("shows divergence warnings and badge", async () => {
		const { target } = await mountView([
			server({
				name: "diverge",
				serverInfo: { name: "diverge" },
				tools: [],
				prompts: [],
				resources: [],
				divergence: [{ field: "tools", message: "alpha has 3, beta has 2" }],
			}),
		]);
		expect(target.textContent).toContain("divergent");
		await dom?.fire(target.querySelector("button.server-row") as Element, "click");
		expect(target.textContent).toContain("Divergence warnings");
		expect(target.textContent).toContain("alpha has 3, beta has 2");
	});

	it("renders partial-inventory host chips with the explanatory note", async () => {
		const { target } = await mountView([
			server({
				name: "mixed",
				tools: [{ name: "a", annotations: {} }],
				hosts: [
					host({ site_id: "s1", host_name: "current" }),
					host({ site_id: "s2", host_name: "old", has_capability_data: false, online_at: null }),
				],
			}),
		]);
		await dom?.fire(target.querySelector("button.server-row") as Element, "click");
		expect(target.textContent).toContain("current");
		expect(target.textContent).toContain("old");
		expect(target.textContent).toContain("partial inventory");
		expect(target.textContent).toContain("partial inventory”");
		const partialChip = target.querySelector(".host-chip.partial");
		expect(partialChip).toBeTruthy();
		expect(partialChip?.getAttribute("title")).toBe("never seen");
	});

	it("shows the no-tools states for both capability-present and legacy servers", async () => {
		const { target } = await mountView([
			server({
				name: "full-empty",
				serverInfo: { name: "full-empty" },
				tools: [],
				prompts: [],
				resources: [],
			}),
			server({ name: "legacy-empty", tools: [], hosts: [host({ has_capability_data: false })] }),
		]);
		const rows = target.querySelectorAll("button.server-row");
		await dom?.fire(rows[0] as Element, "click");
		expect(target.textContent).toContain("This server exposes no tools.");
		await dom?.fire(rows[1] as Element, "click");
		expect(target.textContent).toContain("No capability data captured for this server");
	});

	it("surfaces a pending authorization badge and CLI affordance when not resolvable", async () => {
		const { target } = await mountView(
			[
				server({
					name: "needs-auth",
					serverInfo: { name: "needs-auth" },
					tools: [],
					prompts: [],
					resources: [],
				}),
			],
			{
				servers: {
					"needs-auth": {
						challengeId: "chal-1",
						serverName: "needs-auth",
						scopeDemand: "repo read",
						failureReason: null,
						status: "pending",
					},
				},
				loopback: false,
				canResolve: false,
			},
		);
		expect(target.textContent).toContain("needs authorization");
		await dom?.fire(target.querySelector("button.server-row") as Element, "click");
		expect(target.textContent).toContain("This server needs authorization");
		expect(target.textContent).toContain("repo read");
		expect(target.textContent).toContain("bound login --challenge chal-1");
	});

	it("claims a loopback challenge and opens the authorize URL", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp/servers", () => ({
			servers: [
				server({
					name: "needs-auth",
					serverInfo: { name: "needs-auth" },
					tools: [],
					prompts: [],
					resources: [],
				}),
			],
		}));
		dom.route("GET", "/api/mcp-challenges/by-server", () => ({
			servers: {
				"needs-auth": {
					challengeId: "chal-1",
					serverName: "needs-auth",
					scopeDemand: "repo read",
					failureReason: null,
					status: "pending",
				},
			},
			loopback: true,
			canResolve: true,
		}));
		dom.route("POST", "/api/mcp-challenges/chal-1/claim", () => ({
			authorizeUrl: "https://example.test/authorize?x=1",
		}));
		const opened: Array<[string, string, string]> = [];
		dom.window.open = ((url: string, target?: string, features?: string) => {
			opened.push([url, target ?? "", features ?? ""]);
			return null;
		}) as typeof window.open;
		const Component = (await import("../../views/McpServersView.svelte")).default;
		const { target } = await dom.mount(Component, {});
		await dom.settle();
		await dom.fire(target.querySelector("button.server-row") as Element, "click");

		const authButton = target.querySelector("button.auth-button");
		expect(authButton?.textContent).toContain("Authorize");
		await dom.fire(authButton as Element, "click");

		const claim = dom.requests.find((r) => r.method === "POST" && r.path.includes("/claim"));
		expect(claim).toBeTruthy();
		expect(opened).toHaveLength(1);
		expect(opened[0][0]).toBe("https://example.test/authorize?x=1");
		expect(opened[0][1]).toBe("_blank");
	});

	it("shows a claim error when the claim call fails", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp/servers", () => ({
			servers: [
				server({
					name: "needs-auth",
					serverInfo: { name: "needs-auth" },
					tools: [],
					prompts: [],
					resources: [],
				}),
			],
		}));
		dom.route("GET", "/api/mcp-challenges/by-server", () => ({
			servers: {
				"needs-auth": {
					challengeId: "chal-err",
					serverName: "needs-auth",
					scopeDemand: "repo read",
					failureReason: null,
					status: "pending",
				},
			},
			loopback: true,
			canResolve: true,
		}));
		dom.route(
			"POST",
			"/api/mcp-challenges/chal-err/claim",
			() =>
				new Response(JSON.stringify({ error: "device offline" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		);
		const Component = (await import("../../views/McpServersView.svelte")).default;
		const { target } = await dom.mount(Component, {});
		await dom.settle();
		await dom.fire(target.querySelector("button.server-row") as Element, "click");
		await dom.fire(target.querySelector("button.auth-button") as Element, "click");
		expect(target.textContent).toContain("device offline");
	});

	it("renders a failed authorization badge and the failure reason", async () => {
		const { target } = await mountView(
			[
				server({
					name: "bad-auth",
					serverInfo: { name: "bad-auth" },
					tools: [],
					prompts: [],
					resources: [],
				}),
			],
			{
				servers: {
					"bad-auth": {
						challengeId: "chal-2",
						serverName: "bad-auth",
						scopeDemand: "",
						failureReason: "token exchange rejected",
						status: "failed",
					},
				},
			},
		);
		expect(target.textContent).toContain("authorization failed");
		await dom?.fire(target.querySelector("button.server-row") as Element, "click");
		expect(target.textContent).toContain("The last authorization attempt failed");
		expect(target.textContent).toContain("token exchange rejected");
	});
});
