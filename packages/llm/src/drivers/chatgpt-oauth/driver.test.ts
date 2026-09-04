import { describe, expect, it } from "bun:test";
import { createChatGptOAuthFetch } from "./driver";

describe("createChatGptOAuthFetch", () => {
	it("replaces the SDK sentinel authorization and injects the ChatGPT account headers", async () => {
		let seen: Request | undefined;
		const wrapped = createChatGptOAuthFetch({
			tokenManager: {
				getAccessToken: async () => ({ accessToken: "access-token", accountId: "acct_123" }),
			},
			baseFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				seen = new Request(input, init);
				return new Response("ok");
			}) as typeof fetch,
		});

		await wrapped("https://chatgpt.com/backend-api/codex/responses", {
			headers: { Authorization: "Bearer sentinel" },
		});

		expect(seen?.headers.get("authorization")).toBe("Bearer access-token");
		expect(seen?.headers.get("chatgpt-account-id")).toBe("acct_123");
		expect(seen?.headers.get("user-agent")).toBe("bound");
		expect(seen?.headers.get("originator")).toBe("bound");
	});
});
