import { describe, expect, it } from "bun:test";
import { createSigV4Fetch } from "../sigv4-fetch";

const MANTLE_URL = "https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses";

describe("createSigV4Fetch", () => {
	it("signs each request with a SigV4 Authorization header before delegating to base fetch", async () => {
		let seen: Request | undefined;
		const baseFetch = (async (input: Request | string | URL) => {
			seen = input instanceof Request ? input : new Request(input);
			return new Response("ok");
		}) as unknown as typeof fetch;

		const signedFetch = createSigV4Fetch({
			credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }),
			service: "bedrock",
			region: "us-west-2",
			baseFetch,
		});

		const res = await signedFetch(MANTLE_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "openai.gpt-5.4" }),
		});

		expect(await res.text()).toBe("ok");
		expect(seen).toBeDefined();
		const auth = seen?.headers.get("authorization") ?? "";
		expect(auth).toContain("AWS4-HMAC-SHA256");
		// Scope binds the request to the configured region + service.
		expect(auth).toContain("/us-west-2/bedrock/aws4_request");
		expect(seen?.headers.get("x-amz-date")).toBeTruthy();
	});

	it("forwards a sessionToken into the signed headers when the credentials carry one", async () => {
		let seen: Request | undefined;
		const baseFetch = (async (input: Request | string | URL) => {
			seen = input instanceof Request ? input : new Request(input);
			return new Response("ok");
		}) as unknown as typeof fetch;

		const signedFetch = createSigV4Fetch({
			credentials: async () => ({
				accessKeyId: "AKID",
				secretAccessKey: "secret",
				sessionToken: "session-token-value",
			}),
			service: "bedrock",
			region: "us-west-2",
			baseFetch,
		});

		await signedFetch(MANTLE_URL, { method: "POST", body: "{}" });

		expect(seen?.headers.get("x-amz-security-token")).toBe("session-token-value");
	});

	it("re-fetches credentials per request so a refreshing provider's rotation is honored", async () => {
		let calls = 0;
		const baseFetch = (async () => new Response("ok")) as unknown as typeof fetch;
		const signedFetch = createSigV4Fetch({
			credentials: async () => {
				calls += 1;
				return { accessKeyId: `AKID${calls}`, secretAccessKey: "secret" };
			},
			service: "bedrock",
			region: "us-west-2",
			baseFetch,
		});

		await signedFetch(MANTLE_URL, { method: "POST", body: "{}" });
		await signedFetch(MANTLE_URL, { method: "POST", body: "{}" });

		expect(calls).toBe(2);
	});
});
