// `bound login --chatgpt` — the "Sign in with ChatGPT" browser flow.
//
// Runs the OAuth 2.0 Authorization Code + PKCE dance against auth.openai.com,
// captures the loopback redirect on port 1455, exchanges the code for tokens,
// and persists a bound-owned token store. The auth core (packages/llm) owns the
// pure crypto/HTTP; this command owns the impure edges — binding the local
// callback server, opening the browser, and file placement.
//
// The store is bound-owned (config/chatgpt-auth.json). It is deliberately NOT
// seeded from ~/.codex/auth.json: OpenAI rotates the refresh token on each
// refresh and invalidates the prior one, so two tools sharing a single refresh
// lineage would take turns logging each other out. bound gets its own lineage
// via the browser flow.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
	CHATGPT_OAUTH_REDIRECT_URI,
	buildAuthorizeUrl,
	exchangeCodeForTokens,
	extractIdClaims,
	generatePkce,
	generateState,
} from "@bound/llm";
import { FileTokenStore } from "@bound/llm";

export interface LoginArgs {
	chatgpt?: boolean;
	/** `bound login --challenge <id>`: claim a previously-raised MCP OAuth challenge (R-MO27e). */
	challenge?: string;
	/** `bound login --mcp <server>`: raise-and-resolve an MCP server's challenge for warm-up (R-MO27e). */
	mcp?: string;
	configDir?: string;
	/** Injectable for tests — defaults to opening the OS browser. */
	openBrowser?: (url: string) => void;
	/** Injectable for tests — the daemon base URL (defaults to the local web router). */
	daemonUrl?: string;
	/** Injectable for tests — fetch against the daemon. */
	fetchImpl?: typeof fetch;
}

/** The loopback callback binds this host:port; must match the registered redirect_uri. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

/** Default bound-owned token store location, a sibling of the other config files. */
export function defaultTokenStorePath(configDir: string): string {
	return resolve(configDir, "chatgpt-auth.json");
}

/** Open a URL in the default browser, best-effort per platform. */
function openInBrowser(url: string): void {
	const platform = process.platform;
	const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			/* fall through to the printed URL */
		});
		child.unref();
	} catch {
		/* the URL is always printed as a fallback */
	}
}

/**
 * Wait for the OAuth redirect on the loopback callback, verifying `state`.
 * Resolves with the authorization code. Uses Bun.serve on the fixed port the
 * redirect_uri names; rejects if that port is already bound (a stale server or
 * another login already running).
 */
function awaitCallback(expectedState: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		let server: ReturnType<typeof Bun.serve> | undefined;
		const timeout = setTimeout(
			() => {
				server?.stop(true);
				reject(new Error("timed out waiting for the browser redirect (5 min)"));
			},
			5 * 60 * 1000,
		);
		try {
			server = Bun.serve({
				port: CALLBACK_PORT,
				hostname: "localhost",
				fetch(req) {
					const url = new URL(req.url);
					if (url.pathname !== CALLBACK_PATH) {
						return new Response("not found", { status: 404 });
					}
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");
					const errorParam = url.searchParams.get("error");
					if (errorParam) {
						clearTimeout(timeout);
						queueMicrotask(() => server?.stop(true));
						reject(new Error(`authorization failed: ${errorParam}`));
						return new Response(`Login failed: ${errorParam}. You can close this tab.`, {
							status: 400,
						});
					}
					if (!code || state !== expectedState) {
						clearTimeout(timeout);
						queueMicrotask(() => server?.stop(true));
						reject(new Error("callback missing code or state mismatch (possible CSRF)"));
						return new Response("Invalid callback. You can close this tab.", { status: 400 });
					}
					clearTimeout(timeout);
					queueMicrotask(() => server?.stop(true));
					resolvePromise(code);
					return new Response(
						"Signed in to ChatGPT for bound. You can close this tab and return to the terminal.",
						{ headers: { "content-type": "text/plain" } },
					);
				},
			});
		} catch (e) {
			clearTimeout(timeout);
			reject(
				new Error(
					`could not bind the loopback callback on localhost:${CALLBACK_PORT} — is a Codex login or another bound login already running? (${e instanceof Error ? e.message : String(e)})`,
				),
			);
		}
	});
}

export async function runLogin(args: LoginArgs): Promise<void> {
	// MCP OAuth challenge resolution (R-MO27e/R-MO28): `bound login --challenge <id>`
	// or `bound login --mcp <server>`. Both act THROUGH a running local daemon —
	// the daemon reads the synced challenge, its web router serves the canonical
	// callback (R-MO27), and its sync process writes and transfers the durable_work
	// handoff. A bare CLI on a daemon-less machine cannot resolve a challenge.
	if (args.challenge || args.mcp) {
		await runMcpLogin(args);
		return;
	}
	if (!args.chatgpt) {
		console.error(
			"Usage:\n" +
				"  bound login --chatgpt [--config-dir <dir>]\n" +
				"  bound login --challenge <id> [--url <daemon>]\n" +
				"  bound login --mcp <server> [--url <daemon>]",
		);
		process.exit(1);
	}
	const configDir = args.configDir || "config";
	const storePath = defaultTokenStorePath(configDir);
	const store = new FileTokenStore(storePath);

	// Full browser flow.
	const pkce = generatePkce();
	const state = generateState();
	const authorizeUrl = buildAuthorizeUrl({ pkce, state });

	const callbackPromise = awaitCallback(state);

	console.log("Opening your browser to sign in with ChatGPT…");
	console.log(`If it doesn't open, visit this URL:\n\n  ${authorizeUrl}\n`);
	console.log(`Waiting for the redirect to ${CHATGPT_OAUTH_REDIRECT_URI} …`);
	(args.openBrowser ?? openInBrowser)(authorizeUrl);

	const code = await callbackPromise;
	const tokens = await exchangeCodeForTokens(
		{ fetch: globalThis.fetch },
		{
			code,
			codeVerifier: pkce.verifier,
		},
	);
	await store.save(tokens);
	console.log(`\nSigned in. Tokens saved to ${storePath}`);
	console.log(`Account: ${extractIdClaims(tokens.idToken).email ?? tokens.accountId}`);
	console.log(
		'Add a backend with `provider: "chatgpt-oauth"` to config/model_backends.js to use it.',
	);
}

/**
 * Default daemon web-router base (WEB_PORT, loopback). The CLI acts through the
 * daemon: it serves the canonical callback and transfers the handoff (R-MO27e).
 */
const DEFAULT_DAEMON_URL = "http://localhost:3001";

/**
 * `bound login --challenge <id>` / `--mcp <server>` (R-MO27e/R-MO28). REQUIRES a
 * running local daemon: the CLI verifies the daemon is reachable, then hands the
 * resolution to it. The daemon reads the synced challenge, its in-process
 * resolver mints the per-attempt authorize URL, its web router catches the
 * loopback callback (R-MO27), and its sync process writes and transfers the
 * durable_work handoff to the owning host. A bare CLI on a daemon-less machine
 * cannot resolve a challenge — it errors actionably.
 *
 * PKCE/state primitives are reused from the generalized `@bound/llm` auth-core
 * (generatePkce/generateState), NOT the hardcoded port-1455 chatgpt listener
 * (R-MO28): the resolver, not the CLI, binds the callback.
 */
export async function runMcpLogin(args: LoginArgs): Promise<void> {
	const daemonUrl = args.daemonUrl ?? DEFAULT_DAEMON_URL;
	const fetchImpl = args.fetchImpl ?? globalThis.fetch;

	// A running local daemon is a hard prerequisite (R-MO27e). Probe the web
	// router's status endpoint; a connection failure is the actionable error.
	try {
		const probe = await fetchImpl(`${daemonUrl}/api/status`, { method: "GET" });
		if (!probe.ok && probe.status >= 500) {
			throw new Error(`daemon returned ${probe.status}`);
		}
	} catch (e) {
		throw new Error(
			`bound login --${args.challenge ? "challenge" : "mcp"} requires a running local daemon at ${daemonUrl}, but it is unreachable (${e instanceof Error ? e.message : String(e)}). Start it with \`bound start\` and retry — the daemon serves the OAuth callback and transfers the handoff.`,
		);
	}

	const target = args.challenge
		? { kind: "challenge" as const, value: args.challenge }
		: { kind: "mcp" as const, value: args.mcp ?? "" };

	// The daemon owns the claim + authorize-URL mint (its in-process resolver
	// holds the per-attempt state and binds the callback). Instruct it to begin
	// resolution and surface the authorize URL for the operator's browser.
	const body =
		target.kind === "challenge" ? { challenge_id: target.value } : { server_name: target.value };
	const res = await fetchImpl(`${daemonUrl}/oauth/mcp/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`daemon could not claim the ${target.kind === "challenge" ? `challenge ${target.value}` : `challenge for server ${target.value}`}: ${res.status} ${detail}`.trim(),
		);
	}
	const claim = (await res.json()) as { authorize_url?: string; challenge_id?: string };
	if (!claim.authorize_url) {
		throw new Error("daemon did not return an authorize URL for the claim");
	}

	console.log(
		`Resolving MCP authorization${claim.challenge_id ? ` (challenge ${claim.challenge_id})` : ""}…`,
	);
	console.log(`If your browser doesn't open, visit this URL:\n\n  ${claim.authorize_url}\n`);
	console.log(
		"After you consent, the daemon catches the callback and hands the code to the owning host. Watch the thread that raised the challenge — it is woken on resolution.",
	);
	(args.openBrowser ?? openInBrowser)(claim.authorize_url);
}
