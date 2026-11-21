import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AuthCoreDeps, type CopilotTokens, isExpired, refreshTokens } from "./auth-core";

/** Persists the rotating Copilot OAuth token bundle at an injected path. */
export class FileCopilotTokenStore {
	constructor(private readonly path: string) {}

	load(): CopilotTokens | null {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (!isCopilotTokens(parsed)) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	save(tokens: CopilotTokens): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(tokens), "utf8");
	}
}

function isCopilotTokens(value: unknown): value is CopilotTokens {
	if (typeof value !== "object" || value === null) return false;
	const tokens = value as Record<string, unknown>;
	return (
		typeof tokens.accessToken === "string" &&
		typeof tokens.refreshToken === "string" &&
		typeof tokens.accessTokenExpiresAt === "number"
	);
}

/**
 * Owns the live Copilot OAuth bundle and serializes refresh-token rotation. A
 * refresh response replaces the refresh token and invalidates the prior one, so
 * persistence completes before callers can use the new access token, and
 * concurrent expiry checks share one in-flight POST (single-flight). Mirrors the
 * chatgpt-oauth TokenManager.
 */
export class CopilotTokenManager {
	private refreshInFlight: Promise<CopilotTokens> | null = null;

	constructor(
		private tokens: CopilotTokens,
		private readonly deps: AuthCoreDeps,
		private readonly store: Pick<FileCopilotTokenStore, "save">,
	) {}

	async getAccessToken(): Promise<string> {
		if (isExpired(this.tokens, (this.deps.now ?? Date.now)())) {
			this.tokens = await this.refresh();
		}
		return this.tokens.accessToken;
	}

	private refresh(): Promise<CopilotTokens> {
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
