import { describe, expect, it } from "bun:test";
import {
	AUTO_SESSION_EXPIRY_MARGIN_MS,
	CopilotAutoSessionCache,
	resolveAutoSession,
} from "./auto-session";

const apiEndpoint = "https://api.individual.githubcopilot.com";

/** A fetch stub returning a canned `{api}/auto` response. */
function autoFetch(
	body: unknown,
	opts: { status?: number; onCall?: (req: Request) => void } = {},
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		opts.onCall?.(new Request(input, init));
		return new Response(JSON.stringify(body), {
			status: opts.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

describe("resolveAutoSession", () => {
	it("POSTs the truncated prompt and parses session_token + selected model", async () => {
		let seen: Request | undefined;
		const session = await resolveAutoSession(
			{
				apiEndpoint,
				now: () => 1_000_000,
				fetch: autoFetch(
					{
						session_token: "sess-xyz",
						selected_model: { id: "mai-code-2-flash" },
						expires_at: 2000, // unix seconds
						selection_reason: "cheapest for this prompt",
					},
					{
						onCall: (r) => {
							seen = r;
						},
					},
				),
			},
			"a".repeat(10000),
		);
		expect(seen?.url).toBe(`${apiEndpoint}/auto`);
		const body = (await seen?.clone().json()) as { prompt: string };
		expect(body.prompt.length).toBe(4000); // truncated to AUTO_PROMPT_MAX_CHARS
		expect(session.sessionToken).toBe("sess-xyz");
		expect(session.selectedModelId).toBe("mai-code-2-flash");
		expect(session.expiresAt).toBe(2000 * 1000); // seconds → ms
		expect(session.selectionReason).toBe("cheapest for this prompt");
	});

	it("throws on a non-OK response", async () => {
		await expect(
			resolveAutoSession({ apiEndpoint, fetch: autoFetch({}, { status: 500 }) }, "hi"),
		).rejects.toThrow(/auto-session failed/);
	});

	it("throws when the response is missing required fields", async () => {
		await expect(
			resolveAutoSession({ apiEndpoint, fetch: autoFetch({ selected_model: {} }) }, "hi"),
		).rejects.toThrow(/missing session_token/);
	});
});

describe("CopilotAutoSessionCache", () => {
	function makeSession(expiresAtSec: number) {
		return {
			session_token: "sess-1",
			selected_model: { id: "mai-code-2-flash" },
			expires_at: expiresAtSec,
		};
	}

	it("caches per threadId and reuses a valid session", async () => {
		let calls = 0;
		const cache = new CopilotAutoSessionCache({
			apiEndpoint,
			now: () => 0,
			fetch: autoFetch(makeSession(3600), { onCall: () => calls++ }),
		});
		const a = await cache.get("thread-1", "hi");
		const b = await cache.get("thread-1", "hi again");
		expect(a.sessionToken).toBe("sess-1");
		expect(b).toBe(a);
		expect(calls).toBe(1);
	});

	it("keys distinct threads to distinct sessions", async () => {
		let calls = 0;
		const cache = new CopilotAutoSessionCache({
			apiEndpoint,
			now: () => 0,
			fetch: autoFetch(makeSession(3600), { onCall: () => calls++ }),
		});
		await cache.get("thread-1", "hi");
		await cache.get("thread-2", "hi");
		expect(calls).toBe(2);
	});

	it("re-resolves when within the expiry margin", async () => {
		let calls = 0;
		let clock = 0;
		const expiresAtSec = 3600; // expiresAt = 3_600_000 ms
		const cache = new CopilotAutoSessionCache({
			apiEndpoint,
			now: () => clock,
			fetch: autoFetch(makeSession(expiresAtSec), { onCall: () => calls++ }),
		});
		await cache.get("thread-1", "hi");
		expect(calls).toBe(1);
		// Advance to within the 5-minute margin of expiry.
		clock = 3_600_000 - AUTO_SESSION_EXPIRY_MARGIN_MS + 1;
		await cache.get("thread-1", "hi");
		expect(calls).toBe(2);
	});

	it("re-resolves after invalidation (4xx session error path)", async () => {
		let calls = 0;
		const cache = new CopilotAutoSessionCache({
			apiEndpoint,
			now: () => 0,
			fetch: autoFetch(makeSession(3600), { onCall: () => calls++ }),
		});
		await cache.get("thread-1", "hi");
		cache.invalidate("thread-1");
		await cache.get("thread-1", "hi");
		expect(calls).toBe(2);
	});

	it("single-flights concurrent resolutions for the same key", async () => {
		let calls = 0;
		const cache = new CopilotAutoSessionCache({
			apiEndpoint,
			now: () => 0,
			fetch: (async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 10));
				return new Response(JSON.stringify(makeSession(3600)), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});
		await Promise.all([cache.get("thread-1", "hi"), cache.get("thread-1", "hi")]);
		expect(calls).toBe(1);
	});
});
