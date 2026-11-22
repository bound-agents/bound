import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AuthCoreDeps, type ChatGptTokens, isExpired, refreshTokens } from "./auth-core";

/** Persists the complete rotating ChatGPT OAuth token bundle at an injected path. */
export class FileTokenStore {
	constructor(private readonly path: string) {}

	load(): ChatGptTokens | null {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (!isChatGptTokens(parsed)) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	save(tokens: ChatGptTokens): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(tokens), "utf8");
	}
}

function isChatGptTokens(value: unknown): value is ChatGptTokens {
	if (typeof value !== "object" || value === null) return false;
	const tokens = value as Record<string, unknown>;
	return (
		typeof tokens.accessToken === "string" &&
		typeof tokens.refreshToken === "string" &&
		typeof tokens.idToken === "string" &&
		typeof tokens.accountId === "string" &&
		typeof tokens.accessTokenExpiresAt === "number"
	);
}

/**
 * Owns the live OAuth bundle and serializes refresh-token rotation. A refresh
 * response replaces the refresh token, so persistence completes before callers
 * can use the new access token and concurrent expiry checks share one POST.
 */
export class TokenManager {
	private refreshInFlight: Promise<ChatGptTokens> | null = null;

	constructor(
		private tokens: ChatGptTokens,
		private readonly deps: AuthCoreDeps,
		private readonly store: FileTokenStore,
	) {}

	async getAccessToken(): Promise<{ accessToken: string; accountId: string }> {
		if (isExpired(this.tokens, (this.deps.now ?? Date.now)())) {
			this.tokens = await this.refresh();
		}
		return { accessToken: this.tokens.accessToken, accountId: this.tokens.accountId };
	}

	/**
	 * Force a credential refresh regardless of the cached token's expiry (#285,
	 * R-RT13). Called by the driver's `refreshAuth` hook after a live `401`, where
	 * the provider has rejected the current token even though our local
	 * expiry-clock thinks it is still valid (clock skew, server-side revocation).
	 * Resolves `true` on a successful rotation, `false` if the refresh itself
	 * fails (expired/revoked refresh token → human re-login required).
	 */
	async forceRefresh(): Promise<boolean> {
		try {
			this.tokens = await this.refresh();
			return true;
		} catch {
			return false;
		}
	}

	private refresh(): Promise<ChatGptTokens> {
		if (!this.refreshInFlight) {
			this.refreshInFlight = (async () => {
				const rotated = await refreshTokens(this.deps, this.tokens);
				await this.store.save(rotated);
				this.tokens = rotated;
				return rotated;
			})().finally(() => {
				this.refreshInFlight = null;
			});
		}
		return this.refreshInFlight;
	}
}
