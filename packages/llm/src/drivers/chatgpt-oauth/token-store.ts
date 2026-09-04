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
