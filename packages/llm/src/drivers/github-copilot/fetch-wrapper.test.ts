import { describe, expect, it } from "bun:test";
import {
	COPILOT_API_VERSION,
	COPILOT_INTEGRATION_ID,
	COPILOT_OPENAI_INTENT,
	type CopilotRequestContext,
	createCopilotControlFetch,
	createCopilotFetch,
	resolveInitiator,
} from "./fetch-wrapper";

/** A base fetch that records the final decorated request. */
function capturingBase(): { fetch: typeof fetch; seen: () => Request | undefined } {
	let seen: Request | undefined;
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen = new Request(input, init);
		return new Response("ok");
	}) as typeof fetch;
	return { fetch: fetchImpl, seen: () => seen };
}

describe("createCopilotFetch", () => {
	const baseCtx: CopilotRequestContext = { initiator: "user", hasImages: false };

	it("sets the required Copilot headers on every request", async () => {
		const base = capturingBase();
		const wrapped = createCopilotFetch({
			getAccessToken: async () => "ghu_abc",
			getRequestContext: () => baseCtx,
			baseFetch: base.fetch,
		});
		await wrapped("https://api.individual.githubcopilot.com/v1/messages", { method: "POST" });
		const req = base.seen();
		expect(req?.headers.get("authorization")).toBe("Bearer ghu_abc");
		expect(req?.headers.get("copilot-integration-id")).toBe(COPILOT_INTEGRATION_ID);
		expect(req?.headers.get("x-github-api-version")).toBe(COPILOT_API_VERSION);
		expect(req?.headers.get("openai-intent")).toBe(COPILOT_OPENAI_INTENT);
		expect(req?.headers.get("user-agent")).toBe("bound");
		expect(req?.headers.get("x-initiator")).toBe("user");
	});

	it("strips an SDK-injected x-api-key and authorization and installs the Bearer", async () => {
		const base = capturingBase();
		const wrapped = createCopilotFetch({
			getAccessToken: async () => "ghu_real",
			getRequestContext: () => baseCtx,
			baseFetch: base.fetch,
		});
		// Simulate @ai-sdk/anthropic's placeholder auth.
		await wrapped("https://api.individual.githubcopilot.com/v1/messages", {
			method: "POST",
			headers: { "x-api-key": "placeholder", authorization: "Bearer placeholder" },
		});
		const req = base.seen();
		expect(req?.headers.get("x-api-key")).toBeNull();
		expect(req?.headers.get("authorization")).toBe("Bearer ghu_real");
	});

	it("sets x-initiator to agent when the latest message is non-user-initiated", async () => {
		const base = capturingBase();
		const wrapped = createCopilotFetch({
			getAccessToken: async () => "ghu_abc",
			getRequestContext: () => ({ initiator: "agent", hasImages: false }),
			baseFetch: base.fetch,
		});
		await wrapped("https://api.individual.githubcopilot.com/responses", { method: "POST" });
		expect(base.seen()?.headers.get("x-initiator")).toBe("agent");
	});

	it("sends Copilot-Vision-Request only when the request carries images", async () => {
		const withImages = capturingBase();
		const w1 = createCopilotFetch({
			getAccessToken: async () => "ghu_abc",
			getRequestContext: () => ({ initiator: "user", hasImages: true }),
			baseFetch: withImages.fetch,
		});
		await w1("https://api.individual.githubcopilot.com/v1/messages", { method: "POST" });
		expect(withImages.seen()?.headers.get("copilot-vision-request")).toBe("true");

		const noImages = capturingBase();
		const w2 = createCopilotFetch({
			getAccessToken: async () => "ghu_abc",
			getRequestContext: () => baseCtx,
			baseFetch: noImages.fetch,
		});
		await w2("https://api.individual.githubcopilot.com/v1/messages", { method: "POST" });
		expect(noImages.seen()?.headers.get("copilot-vision-request")).toBeNull();
	});

	it("sends Copilot-Session-Token only when an auto-session token is present", async () => {
		const withToken = capturingBase();
		const w1 = createCopilotFetch({
			getAccessToken: async () => "ghu_abc",
			getRequestContext: () => ({ initiator: "user", hasImages: false, sessionToken: "sess-xyz" }),
			baseFetch: withToken.fetch,
		});
		await w1("https://api.individual.githubcopilot.com/responses", { method: "POST" });
		expect(withToken.seen()?.headers.get("copilot-session-token")).toBe("sess-xyz");

		const noToken = capturingBase();
		const w2 = createCopilotFetch({
			getAccessToken: async () => "ghu_abc",
			getRequestContext: () => baseCtx,
			baseFetch: noToken.fetch,
		});
		await w2("https://api.individual.githubcopilot.com/responses", { method: "POST" });
		expect(noToken.seen()?.headers.get("copilot-session-token")).toBeNull();
	});
});

describe("createCopilotControlFetch", () => {
	it("sets the Bearer + integration id without the per-turn knobs", async () => {
		const base = capturingBase();
		const wrapped = createCopilotControlFetch({
			getAccessToken: async () => "ghu_abc",
			baseFetch: base.fetch,
		});
		await wrapped("https://api.individual.githubcopilot.com/models", { method: "GET" });
		const req = base.seen();
		expect(req?.headers.get("authorization")).toBe("Bearer ghu_abc");
		expect(req?.headers.get("copilot-integration-id")).toBe(COPILOT_INTEGRATION_ID);
		expect(req?.headers.get("x-github-api-version")).toBe(COPILOT_API_VERSION);
		expect(req?.headers.get("x-initiator")).toBeNull();
		expect(req?.headers.get("copilot-vision-request")).toBeNull();
	});
});

describe("resolveInitiator", () => {
	it("is 'user' only for a plain user turn", () => {
		expect(resolveInitiator("user")).toBe("user");
	});
	it("is 'agent' for tool results, assistant, developer, cache, and undefined", () => {
		expect(resolveInitiator("tool_result")).toBe("agent");
		expect(resolveInitiator("assistant")).toBe("agent");
		expect(resolveInitiator("developer")).toBe("agent");
		expect(resolveInitiator("cache")).toBe("agent");
		expect(resolveInitiator(undefined)).toBe("agent");
	});
});
