import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

type Challenge = {
	challengeId: string;
	serverName: string;
	scopeDemand: string;
	failureReason: string | null;
};

function challengesResponse(challenges: Challenge[], loopback: boolean, canResolve: boolean) {
	return { challenges, loopback, canResolve };
}

describe("McpChallengeCard", () => {
	it("renders nothing when there are no pending challenges", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () => challengesResponse([], true, true));
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		expect(target.querySelector(".challenge-list")).toBeNull();
		expect(target.querySelector(".challenge-error")).toBeNull();
	});

	it("lists each pending challenge with server, scopes and challenge id", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[
					{
						challengeId: "chal-1",
						serverName: "notion",
						scopeDemand: "read write",
						failureReason: null,
					},
				],
				true,
				true,
			),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		expect(target.querySelector(".server")?.textContent).toBe("notion");
		expect(target.querySelector(".scope code")?.textContent).toBe("read write");
		expect(target.querySelector(".challenge-id")?.textContent).toContain("chal-1");
	});

	it("shows the generic scope line when scopeDemand is empty", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[{ challengeId: "c", serverName: "s", scopeDemand: "", failureReason: null }],
				true,
				true,
			),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		expect(target.querySelector(".scope")?.textContent).toContain(
			"The server requires authorization",
		);
		expect(target.querySelector(".scope code")).toBeNull();
	});

	it("renders a previous failure reason when present", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[
					{
						challengeId: "c",
						serverName: "s",
						scopeDemand: "x",
						failureReason: "token expired",
					},
				],
				true,
				true,
			),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		expect(target.querySelector(".failure")?.textContent).toContain("token expired");
	});

	it("under loopback+canResolve, shows the Authorize button and opens the minted URL on claim", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[{ challengeId: "chal-1", serverName: "s", scopeDemand: "x", failureReason: null }],
				true,
				true,
			),
		);
		dom.route("POST", "/api/mcp-challenges/chal-1/claim", () => ({
			authorizeUrl: "https://auth.example/go",
		}));
		const opened: Array<[string, string]> = [];
		dom.window.open = ((url: string, target: string) => {
			opened.push([url, target]);
			return null;
		}) as typeof window.open;
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		const btn = target.querySelector(".actions button") as HTMLButtonElement;
		expect(btn.textContent?.trim()).toBe("Authorize");
		await dom.fire(btn, "click");
		expect(dom.requests.some((r) => r.path === "/api/mcp-challenges/chal-1/claim")).toBe(true);
		expect(opened[0][0]).toBe("https://auth.example/go");
		expect(opened[0][1]).toBe("_blank");
	});

	it("shows the claim error inline when the claim fails", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[{ challengeId: "chal-1", serverName: "s", scopeDemand: "x", failureReason: null }],
				true,
				true,
			),
		);
		dom.route(
			"POST",
			"/api/mcp-challenges/chal-1/claim",
			() => new Response(JSON.stringify({ error: "bridge down" }), { status: 500 }),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		await dom.fire(target.querySelector(".actions button") as HTMLButtonElement, "click");
		expect(target.querySelector(".claim-error")?.textContent).toContain("bridge down");
	});

	it("under a non-loopback bind, shows the CLI instruction instead of a button", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[{ challengeId: "chal-x", serverName: "s", scopeDemand: "x", failureReason: null }],
				false,
				false,
			),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		expect(target.querySelector(".actions button")).toBeNull();
		const cli = target.querySelector(".cli-instruction");
		expect(cli?.textContent).toContain("bound login --challenge chal-x");
	});

	it("surfaces a load error when the challenges request fails", async () => {
		dom = installDom();
		dom.route(
			"GET",
			"/api/mcp-challenges",
			() => new Response(JSON.stringify({ error: "nope" }), { status: 503 }),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		expect(target.querySelector(".challenge-error")?.textContent).toContain("nope");
	});

	it("disables the button while a claim is in flight (Opening…)", async () => {
		dom = installDom();
		dom.route("GET", "/api/mcp-challenges", () =>
			challengesResponse(
				[{ challengeId: "chal-1", serverName: "s", scopeDemand: "x", failureReason: null }],
				true,
				true,
			),
		);
		let release: ((v: unknown) => void) | null = null;
		dom.route(
			"POST",
			"/api/mcp-challenges/chal-1/claim",
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const McpChallengeCard = (await import("../../components/McpChallengeCard.svelte")).default;
		const { target } = await dom.mount(McpChallengeCard, {});
		await dom.settle();
		const btn = target.querySelector(".actions button") as HTMLButtonElement;
		await dom.fire(btn, "click");
		expect(btn.textContent?.trim()).toBe("Opening…");
		expect(btn.disabled).toBe(true);
		release?.({ authorizeUrl: "https://a/b" });
		await dom.settle();
	});
});
