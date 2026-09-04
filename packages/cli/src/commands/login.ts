// `bound login --chatgpt` — the "Sign in with ChatGPT" browser flow.
//
// Runs the OAuth 2.0 Authorization Code + PKCE dance against auth.openai.com,
// captures the loopback redirect on port 1455, exchanges the code for tokens,
// and persists a bound-owned token store. The auth core (packages/llm) owns the
// pure crypto/HTTP; this command owns the impure edges — binding the local
// callback server, opening the browser, and file placement.
//
// The store is bound-owned (config/chatgpt-auth.json), NOT ~/.codex/auth.json:
// sharing Codex's file means two tools racing to rotate one refresh token, and
// whichever refreshes second gets logged out. On first login we OPTIONALLY seed
// from an existing ~/.codex/auth.json (import once, then own our copy) so a user
// already signed into Codex doesn't have to re-auth in the browser.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	CHATGPT_OAUTH_REDIRECT_URI,
	type ChatGptTokens,
	buildAuthorizeUrl,
	exchangeCodeForTokens,
	extractIdClaims,
	generatePkce,
	generateState,
} from "@bound/llm";
import { FileTokenStore } from "@bound/llm";

export interface LoginArgs {
	chatgpt?: boolean;
	configDir?: string;
	/** Skip the browser + loopback capture and seed from ~/.codex/auth.json only. */
	fromCodex?: boolean;
	/** Injectable for tests — defaults to opening the OS browser. */
	openBrowser?: (url: string) => void;
}

/** The loopback callback binds this host:port; must match the registered redirect_uri. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

/** Default bound-owned token store location, a sibling of the other config files. */
export function defaultTokenStorePath(configDir: string): string {
	return resolve(configDir, "chatgpt-auth.json");
}

/** Codex's own store — read-only, seed source only. */
function codexAuthPath(): string {
	return join(homedir(), ".codex", "auth.json");
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
 * Import an existing Codex ~/.codex/auth.json into a bound `ChatGptTokens`.
 * Returns null when the file is absent or not in ChatGPT-account mode (an
 * API-key-only auth.json has no OAuth tokens to seed from).
 */
export function seedFromCodex(rawJson: string): ChatGptTokens | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const tokens = (parsed as Record<string, unknown>).tokens as Record<string, unknown> | undefined;
	if (!tokens) return null;
	const accessToken = tokens.access_token;
	const refreshToken = tokens.refresh_token;
	const idToken = tokens.id_token;
	if (
		typeof accessToken !== "string" ||
		typeof refreshToken !== "string" ||
		typeof idToken !== "string"
	) {
		return null;
	}
	const claims = extractIdClaims(idToken);
	const accountId =
		claims.chatgptAccountId ??
		(typeof tokens.account_id === "string" ? tokens.account_id : undefined);
	if (!accountId) return null;
	// Derive expiry from the access_token exp; a seeded token that's already
	// expired is fine — the TokenManager refreshes on first use.
	let accessTokenExpiresAt = 0;
	try {
		const payload = JSON.parse(
			Buffer.from(
				accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
				"base64",
			).toString("utf8"),
		) as { exp?: number };
		accessTokenExpiresAt = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
	} catch {
		accessTokenExpiresAt = 0;
	}
	return { accessToken, refreshToken, idToken, accountId, accessTokenExpiresAt };
}

/**
 * Wait for the OAuth redirect on the loopback callback, verifying `state`.
 * Resolves with the authorization code. Uses Bun.serve on the fixed port the
 * redirect_uri names; rejects if that port is already bound (a running Codex
 * login, or a stale server).
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
	if (!args.chatgpt) {
		console.error("Usage: bound login --chatgpt [--from-codex] [--config-dir <dir>]");
		process.exit(1);
	}
	const configDir = args.configDir || "config";
	const storePath = defaultTokenStorePath(configDir);
	const store = new FileTokenStore(storePath);

	// Seed path: import an existing Codex session without a browser round-trip.
	if (args.fromCodex) {
		const codexPath = codexAuthPath();
		if (!existsSync(codexPath)) {
			console.error(
				`No Codex auth found at ${codexPath}. Run \`codex login\` first, or omit --from-codex.`,
			);
			process.exit(1);
		}
		const seeded = seedFromCodex(readFileSync(codexPath, "utf8"));
		if (!seeded) {
			console.error(
				`${codexPath} is not a ChatGPT-account session (API-key-only auth.json has no OAuth tokens to import).`,
			);
			process.exit(1);
		}
		await store.save(seeded);
		console.log(`Imported ChatGPT session from Codex → ${storePath}`);
		console.log(`Account: ${extractIdClaims(seeded.idToken).email ?? seeded.accountId}`);
		return;
	}

	// First-run convenience: if no bound store exists yet but a Codex ChatGPT
	// session does, offer the seed rather than forcing a browser flow.
	if ((await store.load()) === null && existsSync(codexAuthPath())) {
		const seeded = seedFromCodex(readFileSync(codexAuthPath(), "utf8"));
		if (seeded) {
			await store.save(seeded);
			console.log(`Found an existing Codex ChatGPT session; imported it → ${storePath}`);
			console.log(`Account: ${extractIdClaims(seeded.idToken).email ?? seeded.accountId}`);
			console.log("(Re-run with just --chatgpt to force a fresh browser login instead.)");
			return;
		}
	}

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
