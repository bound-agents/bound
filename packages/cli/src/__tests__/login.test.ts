import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, runMcpLogin } from "../commands/login";

// These tests drive the impure edges of `bound login` through the injection
// seams the command exposes for exactly this purpose:
//  - runLogin({chatgpt}) binds a real loopback Bun.serve on an OS-assigned port
//    (callbackPort:0) and signals its bound port via onCallbackListening, so the
//    test can POST the OAuth redirect without racing the bind or touching port
//    1455. openBrowser and fetchImpl are stubbed so no browser spawns and no
//    network call escapes.
//  - runMcpLogin({challenge|mcp}) takes daemonUrl + fetchImpl, so a fake daemon
//    response drives the 404 / 503 / handled-error branches deterministically.

/** A browser stub that records the URL it was handed instead of spawning. */
function recordingBrowser(): { open: (url: string) => void; urls: string[] } {
	const urls: string[] = [];
	return { open: (url) => urls.push(url), urls };
}

describe("runLogin — chatgpt browser flow", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "bound-login-"));
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("completes the flow: opens the browser, catches the redirect, exchanges, and saves tokens", async () => {
		const browser = recordingBrowser();

		// Stub the token exchange: the callback hands a code to the auth core,
		// which this fetch stands in for. runLogin only reaches here after the
		// loopback callback resolves with a code, so hitting this proves the
		// browser-flow seam fired end to end.
		const fetchCalls: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			fetchCalls.push(url);
			// Shape mirrors the OpenAI token endpoint response consumed by
			// exchangeCodeForTokens; the id_token is an unsigned JWT whose payload
			// carries the `auth.chatgpt_account_id` claim toTokens() requires, plus a
			// top-level email extractIdClaims reads.
			const payload = Buffer.from(
				JSON.stringify({
					email: "pilot@example.com",
					auth: { chatgpt_account_id: "acct-123" },
				}),
			).toString("base64url");
			const idToken = `eyJhbGciOiJub25lIn0.${payload}.`;
			return new Response(
				JSON.stringify({
					access_token: "acc-tok",
					refresh_token: "ref-tok",
					id_token: idToken,
					expires_in: 3600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		// Drive the redirect as soon as the callback server reports its bound port.
		let redirectError: unknown;
		const done = runLogin({
			chatgpt: true,
			configDir,
			callbackPort: 0,
			openBrowser: browser.open,
			fetchImpl,
			onCallbackListening: (port) => {
				// onCallbackListening fires synchronously during awaitCallback's bind,
				// BEFORE runLogin calls openBrowser. Defer a tick so the browser stub
				// has recorded the authorize URL (whose `state` the callback verifies).
				setTimeout(() => {
					const state = new URL(browser.urls[0]).searchParams.get("state");
					const cb = `http://localhost:${port}/auth/callback?code=the-code&state=${state}`;
					void fetch(cb).catch((e) => {
						redirectError = e;
					});
				}, 0);
			},
		});

		await done;
		expect(redirectError).toBeUndefined();
		// The browser was opened with the authorize URL (never spawned a process).
		expect(browser.urls).toHaveLength(1);
		expect(browser.urls[0]).toContain("state=");
		// The token exchange ran against the injected fetch.
		expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
		// Tokens landed on disk at the bound-owned store path.
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(configDir, "chatgpt-auth.json"))).toBe(true);
	});

	it("rejects a callback whose state does not match (CSRF guard)", async () => {
		const browser = recordingBrowser();

		const failing = runLogin({
			chatgpt: true,
			configDir,
			callbackPort: 0,
			openBrowser: browser.open,
			onCallbackListening: (port) => {
				const cb = `http://localhost:${port}/auth/callback?code=c&state=WRONG-STATE`;
				// The server rejects and immediately stops the socket, so the client
				// fetch may see the 400 or an ECONNRESET depending on flush timing —
				// either way the server-side rejection is the behavior under test.
				void fetch(cb).catch(() => {});
			},
		});

		await expect(failing).rejects.toThrow("callback missing code or state mismatch");
	});

	it("rejects when the provider returns an error param on the callback", async () => {
		const browser = recordingBrowser();

		const failing = runLogin({
			chatgpt: true,
			configDir,
			callbackPort: 0,
			openBrowser: browser.open,
			onCallbackListening: (port) => {
				const cb = `http://localhost:${port}/auth/callback?error=access_denied`;
				void fetch(cb).catch(() => {});
			},
		});

		await expect(failing).rejects.toThrow("authorization failed: access_denied");
	});

	it("a request to an unknown callback path gets a 404 and does not resolve the flow", async () => {
		const browser = recordingBrowser();
		let notFoundStatus = 0;

		const done = runLogin({
			chatgpt: true,
			configDir,
			callbackPort: 0,
			openBrowser: browser.open,
			fetchImpl: (async () => {
				// The completed callback drives a token exchange; return a valid bundle
				// so the flow resolves (the 404 branch is what this test asserts).
				const payload = Buffer.from(
					JSON.stringify({ auth: { chatgpt_account_id: "acct-404" } }),
				).toString("base64url");
				return new Response(
					JSON.stringify({
						access_token: "a",
						refresh_token: "r",
						id_token: `eyJhbGciOiJub25lIn0.${payload}.`,
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as unknown as typeof fetch,
			onCallbackListening: async (port) => {
				// Hit a non-callback path: must 404 and leave the server listening
				// (the 404 branch returns a Response without stopping the server), so
				// the client reads the status cleanly.
				const bad = await fetch(`http://localhost:${port}/nope`);
				notFoundStatus = bad.status;
				// Then complete the flow properly so the promise resolves and the
				// server stops (otherwise the 5-min timer would leak).
				const state = new URL(browser.urls[0]).searchParams.get("state");
				void fetch(`http://localhost:${port}/auth/callback?code=c&state=${state}`).catch(() => {});
			},
		});

		await done;
		expect(notFoundStatus).toBe(404);
	});

	it("prints a usage message and exits non-zero when no mode flag is given", async () => {
		// runLogin with neither chatgpt nor challenge/mcp hits the usage branch,
		// which prints the three invocation forms and calls process.exit(1). Trap
		// process.exit so the test observes the code instead of killing the runner.
		const origExit = process.exit;
		const origErr = console.error;
		let exitCode: number | undefined;
		const errLines: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: test shim for process.exit
		process.exit = ((code?: number) => {
			exitCode = code;
			throw new Error("__exit__");
		}) as any;
		console.error = (m?: unknown) => {
			errLines.push(String(m));
		};
		try {
			await runLogin({}).catch((e) => {
				if (!(e instanceof Error) || e.message !== "__exit__") throw e;
			});
		} finally {
			process.exit = origExit;
			console.error = origErr;
		}
		expect(exitCode).toBe(1);
		expect(errLines.join("\n")).toContain("bound login --chatgpt");
	});
});

describe("runMcpLogin — daemon-backed claim flow", () => {
	it("throws an actionable error when the daemon is unreachable", async () => {
		// Point at a guaranteed-closed ephemeral port (bind then stop) so the
		// probe's connect refuses immediately — deterministic on any host.
		const probe = Bun.serve({ port: 0, hostname: "localhost", fetch: () => new Response("ok") });
		const deadUrl = `http://localhost:${probe.port}`;
		probe.stop(true);

		await expect(runMcpLogin({ mcp: "ghserver", daemonUrl: deadUrl })).rejects.toThrow(
			"requires a running local daemon",
		);
	});

	it("opens the browser with the authorize URL on a successful claim", async () => {
		const browser = recordingBrowser();
		const seen: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			seen.push(url);
			if (url.endsWith("/api/status")) return new Response("{}", { status: 200 });
			// The claim POST returns an authorize URL + challenge id.
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({ authorize_url: "https://idp.example/authz?x=1", challenge_id: "ch-9" }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		await runMcpLogin({
			challenge: "ch-9",
			daemonUrl: "http://daemon.test",
			fetchImpl,
			openBrowser: browser.open,
		});

		expect(seen.some((u) => u.endsWith("/api/status"))).toBe(true);
		expect(seen.some((u) => u.endsWith("/oauth/mcp/claim"))).toBe(true);
		expect(browser.urls).toEqual(["https://idp.example/authz?x=1"]);
	});

	it("maps a 404 claim response to a 'daemon too old' error", async () => {
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/status")) return new Response("{}", { status: 200 });
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		await expect(
			runMcpLogin({ mcp: "ghserver", daemonUrl: "http://daemon.test", fetchImpl }),
		).rejects.toThrow("has no MCP OAuth claim endpoint (404)");
	});

	it("maps a 503 claim response (no resolver on this host) to the handled error, surfacing the JSON detail", async () => {
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/status")) return new Response("{}", { status: 200 });
			return new Response(JSON.stringify({ error: "not configured here" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await expect(
			runMcpLogin({ mcp: "ghserver", daemonUrl: "http://daemon.test", fetchImpl }),
		).rejects.toThrow("runs no MCP OAuth resolver");
		// The JSON `error` detail is surfaced in parentheses.
		await expect(
			runMcpLogin({ mcp: "ghserver", daemonUrl: "http://daemon.test", fetchImpl }),
		).rejects.toThrow("not configured here");
	});

	it("maps any other non-ok claim response to a generic claim-failed error", async () => {
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/status")) return new Response("{}", { status: 200 });
			return new Response(JSON.stringify({ error: "ambiguous site" }), {
				status: 409,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await expect(
			runMcpLogin({ challenge: "ch-1", daemonUrl: "http://daemon.test", fetchImpl }),
		).rejects.toThrow("daemon could not claim the challenge ch-1: ambiguous site");
	});

	it("throws when a successful claim omits the authorize URL", async () => {
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/status")) return new Response("{}", { status: 200 });
			return new Response(JSON.stringify({ challenge_id: "ch-2" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await expect(
			runMcpLogin({ mcp: "ghserver", daemonUrl: "http://daemon.test", fetchImpl }),
		).rejects.toThrow("did not return an authorize URL");
	});

	it("falls back to the real best-effort browser opener when openBrowser is not injected", async () => {
		// No openBrowser injected: the success path calls the module-internal
		// openInBrowser(), which spawns the platform opener detached + unref'd with
		// stdio ignored and swallows any spawn error. The claim must still resolve
		// without throwing regardless of whether a browser exists in the sandbox.
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/status")) return new Response("{}", { status: 200 });
			return new Response(
				JSON.stringify({ authorize_url: "https://idp.example/authz?via=default-opener" }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		await expect(
			runMcpLogin({ mcp: "ghserver", daemonUrl: "http://daemon.test", fetchImpl }),
		).resolves.toBeUndefined();
	});
});
