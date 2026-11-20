import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_OAUTH_REDIRECT_URI } from "@bound/llm";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { type LoginArgs, defaultTokenStorePath, runLogin, runMcpLogin } from "../login";

describe("defaultTokenStorePath", () => {
	it("places the store beside the config dir", () => {
		expect(defaultTokenStorePath("config")).toMatch(/config[\\/]chatgpt-auth\.json$/);
	});

	it("honors a non-default config dir", () => {
		expect(defaultTokenStorePath("/etc/bound")).toMatch(/bound[\\/]chatgpt-auth\.json$/);
	});
});

// ---- Test fixtures: a minimal unsigned JWT the auth-core can decode. ----

/** base64url without padding, matching the auth-core's own encoding. */
function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build an unsigned JWT with the given payload (header.payload.signature). */
function makeJwt(payload: Record<string, unknown>): string {
	const header = base64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })));
	const body = base64url(Buffer.from(JSON.stringify(payload)));
	return `${header}.${body}.`;
}

/** An id_token whose claims carry the mandatory chatgpt_account_id + email. */
function makeIdToken(opts: { accountId?: string; email?: string } = {}): string {
	return makeJwt({
		auth: {
			chatgpt_account_id: opts.accountId ?? "acct-123",
			chatgpt_plan_type: "plus",
		},
		email: opts.email ?? "user@example.com",
	});
}

/** An access_token JWT with an exp an hour out, so it is not treated as expired. */
function makeAccessToken(): string {
	return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
}

/**
 * A fetch stub for the token endpoint. The real `exchangeCodeForTokens` POSTs a
 * hardcoded `CHATGPT_OAUTH_TOKEN_URL`; this intercepts it and returns a canned
 * token response, so the whole exchange runs in-process with no network.
 */
function tokenFetch(
	response: {
		status?: number;
		body?: unknown;
		statusText?: string;
	} = {},
): { fetch: typeof fetch; calls: Array<{ url: string; body: string }> } {
	const calls: Array<{ url: string; body: string }> = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, body: String(init?.body ?? "") });
		const status = response.status ?? 200;
		const body =
			response.body ??
			({
				access_token: makeAccessToken(),
				refresh_token: "refresh-abc",
				id_token: makeIdToken(),
				token_type: "Bearer",
			} as const);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			statusText: response.statusText,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/**
 * Drive the loopback redirect: once the callback server is listening on
 * `port`, GET its callback path with the query params the browser would carry.
 */
async function hitCallback(port: number, params: Record<string, string>): Promise<Response> {
	const url = new URL("/auth/callback", `http://localhost:${port}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return fetch(url.toString());
}

describe("runLogin --chatgpt (in-process browser flow)", () => {
	let dir: string;
	let logs: string[];
	let errors: string[];
	let origLog: typeof console.log;
	let origError: typeof console.error;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bound-login-"));
		logs = [];
		errors = [];
		origLog = console.log;
		origError = console.error;
		console.log = (m?: unknown) => logs.push(String(m));
		console.error = (m?: unknown) => errors.push(String(m));
	});

	afterEach(() => {
		console.log = origLog;
		console.error = origError;
		cleanupTmpDirSync(dir);
	});

	it("completes the flow and writes the token store", async () => {
		const { fetch: fetchImpl, calls } = tokenFetch();
		let seenAuthorizeUrl = "";
		let boundPort = 0;

		const args: LoginArgs = {
			chatgpt: true,
			configDir: dir,
			callbackPort: 0,
			fetchImpl,
			onCallbackListening: (port) => {
				boundPort = port;
			},
			openBrowser: (url) => {
				// openBrowser runs AFTER the callback server is bound (onCallbackListening
				// already captured the port), so the redirect can fire now.
				seenAuthorizeUrl = url;
				const state = new URL(url).searchParams.get("state") ?? "";
				void hitCallback(boundPort, { code: "auth-code-xyz", state }).catch(() => {});
			},
		};

		await runLogin(args);

		// The authorize URL names the registered redirect_uri and carries PKCE.
		expect(seenAuthorizeUrl).toContain("code_challenge=");
		expect(seenAuthorizeUrl).toContain(encodeURIComponent(CHATGPT_OAUTH_REDIRECT_URI));

		// The code was exchanged at the token endpoint with the captured code.
		expect(calls).toHaveLength(1);
		expect(calls[0].body).toContain("code=auth-code-xyz");
		expect(calls[0].body).toContain("grant_type=authorization_code");

		// The token store was written with the bundle.
		const storePath = defaultTokenStorePath(dir);
		const saved = JSON.parse(readFileSync(storePath, "utf8"));
		expect(saved.accountId).toBe("acct-123");
		expect(saved.refreshToken).toBe("refresh-abc");
		expect(logs.join("\n")).toContain("Signed in");
		expect(logs.join("\n")).toContain("user@example.com");
	});

	it("rejects a callback whose state does not match (CSRF guard)", async () => {
		const { fetch: fetchImpl } = tokenFetch();
		let boundPort = 0;
		const args: LoginArgs = {
			chatgpt: true,
			configDir: dir,
			callbackPort: 0,
			fetchImpl,
			onCallbackListening: (port) => {
				boundPort = port;
			},
			openBrowser: () => {
				void hitCallback(boundPort, { code: "x", state: "WRONG-STATE" }).catch(() => {});
			},
		};
		await expect(runLogin(args)).rejects.toThrow(/state mismatch/);
	});

	it("rejects when the authorization server returns an error param", async () => {
		const { fetch: fetchImpl } = tokenFetch();
		let boundPort = 0;
		const args: LoginArgs = {
			chatgpt: true,
			configDir: dir,
			callbackPort: 0,
			fetchImpl,
			onCallbackListening: (port) => {
				boundPort = port;
			},
			openBrowser: () => {
				void hitCallback(boundPort, { error: "access_denied" }).catch(() => {});
			},
		};
		await expect(runLogin(args)).rejects.toThrow(/authorization failed: access_denied/);
	});

	it("propagates a token-exchange failure", async () => {
		const { fetch: fetchImpl } = tokenFetch({ status: 400, statusText: "Bad Request" });
		let boundPort = 0;
		const args: LoginArgs = {
			chatgpt: true,
			configDir: dir,
			callbackPort: 0,
			fetchImpl,
			onCallbackListening: (port) => {
				boundPort = port;
			},
			openBrowser: (url) => {
				const state = new URL(url).searchParams.get("state") ?? "";
				void hitCallback(boundPort, { code: "c", state }).catch(() => {});
			},
		};
		await expect(runLogin(args)).rejects.toThrow(/token exchange failed/);
	});

	it("errors without --chatgpt / --challenge / --mcp (usage, exit 1)", async () => {
		// With no flags, runLogin prints usage and process.exit(1). We stub exit
		// to a throw so the test can assert without killing the runner.
		const origExit = process.exit;
		const thrown = { code: -1 };
		process.exit = ((code?: number) => {
			thrown.code = code ?? 0;
			throw new Error(`exit:${code}`);
		}) as typeof process.exit;
		try {
			await expect(runLogin({ configDir: dir })).rejects.toThrow("exit:1");
			expect(thrown.code).toBe(1);
			expect(errors.join("\n")).toContain("Usage:");
		} finally {
			process.exit = origExit;
		}
	});
});

describe("runMcpLogin (daemon-mediated MCP OAuth)", () => {
	let logs: string[];
	let origLog: typeof console.log;

	beforeEach(() => {
		logs = [];
		origLog = console.log;
		console.log = (m?: unknown) => logs.push(String(m));
	});

	afterEach(() => {
		console.log = origLog;
	});

	/** A fake daemon web router over Bun.serve on an ephemeral port. */
	function fakeDaemon(handlers: {
		status?: (req: Request) => Response;
		claim?: (req: Request) => Response | Promise<Response>;
	}): { url: string; stop: () => void } {
		const server = Bun.serve({
			port: 0,
			hostname: "localhost",
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/api/status") {
					return handlers.status?.(req) ?? new Response("ok", { status: 200 });
				}
				if (url.pathname === "/oauth/mcp/claim") {
					return (
						(await handlers.claim?.(req)) ??
						new Response(JSON.stringify({ authorize_url: "https://auth.example/consent" }), {
							status: 200,
							headers: { "content-type": "application/json" },
						})
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
	}

	it("claims an MCP server by name and surfaces the authorize URL", async () => {
		let claimBody = "";
		const daemon = fakeDaemon({
			claim: async (req) => {
				claimBody = await req.text();
				return new Response(
					JSON.stringify({ authorize_url: "https://auth.example/consent", challenge_id: "ch-9" }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});
		let opened = "";
		try {
			await runMcpLogin({
				mcp: "my-server",
				daemonUrl: daemon.url,
				openBrowser: (url) => {
					opened = url;
				},
			});
		} finally {
			daemon.stop();
		}
		expect(JSON.parse(claimBody)).toEqual({ server_name: "my-server" });
		expect(opened).toBe("https://auth.example/consent");
		expect(logs.join("\n")).toContain("challenge ch-9");
	});

	it("claims a raised challenge by id", async () => {
		let claimBody = "";
		const daemon = fakeDaemon({
			claim: async (req) => {
				claimBody = await req.text();
				return new Response(JSON.stringify({ authorize_url: "https://auth.example/consent" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		try {
			await runMcpLogin({ challenge: "ch-42", daemonUrl: daemon.url, openBrowser: () => {} });
		} finally {
			daemon.stop();
		}
		expect(JSON.parse(claimBody)).toEqual({ challenge_id: "ch-42" });
	});

	it("errors actionably when the daemon is unreachable", async () => {
		// Point at a closed ephemeral port by starting then immediately stopping.
		const daemon = fakeDaemon({});
		const url = daemon.url;
		daemon.stop();
		await expect(runMcpLogin({ mcp: "s", daemonUrl: url, openBrowser: () => {} })).rejects.toThrow(
			/requires a running local daemon/,
		);
	});

	it("maps a 404 claim to an upgrade-the-daemon error", async () => {
		const daemon = fakeDaemon({ claim: () => new Response("Not Found", { status: 404 }) });
		try {
			await expect(
				runMcpLogin({ mcp: "s", daemonUrl: daemon.url, openBrowser: () => {} }),
			).rejects.toThrow(/no MCP OAuth claim endpoint \(404\)/);
		} finally {
			daemon.stop();
		}
	});

	it("maps a 503 claim to a wrong-host error, surfacing the JSON detail", async () => {
		const daemon = fakeDaemon({
			claim: () =>
				new Response(JSON.stringify({ error: "no resolver here" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				}),
		});
		try {
			await expect(
				runMcpLogin({ mcp: "s", daemonUrl: daemon.url, openBrowser: () => {} }),
			).rejects.toThrow(/no resolver here/);
		} finally {
			daemon.stop();
		}
	});

	it("errors when the claim response omits an authorize URL", async () => {
		const daemon = fakeDaemon({
			claim: () =>
				new Response(JSON.stringify({ challenge_id: "ch-1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		try {
			await expect(
				runMcpLogin({ challenge: "ch-1", daemonUrl: daemon.url, openBrowser: () => {} }),
			).rejects.toThrow(/did not return an authorize URL/);
		} finally {
			daemon.stop();
		}
	});

	it("tolerates a non-500 status on the daemon probe", async () => {
		// A 404 on /api/status is NOT a hard failure — only >=500 is. The claim
		// still proceeds.
		const daemon = fakeDaemon({
			status: () => new Response("nope", { status: 404 }),
		});
		try {
			await runMcpLogin({ mcp: "s", daemonUrl: daemon.url, openBrowser: () => {} });
		} finally {
			daemon.stop();
		}
		expect(logs.join("\n")).toContain("Resolving MCP authorization");
	});
});
