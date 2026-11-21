/**
 * GitHub Copilot `model: "auto"` session resolution.
 *
 * Verified wire flow: POST `{api}/auto` with body `{prompt: <last user text,
 * truncated>}` and the standard Copilot headers returns
 * `{session_token, selected_model:{id}, expires_at (unix seconds),
 * selection_reason}`. The SELECTED model id is then called with a
 * `Copilot-Session-Token: <session_token>` header; the token is scoped to that
 * model only and the selected model is routed over `/responses` when it lists
 * that endpoint (verified: mai-code-2-flash + token via /responses 200, via
 * chat 400 no_available_model_endpoints).
 *
 * Sessions are cached per threadId (falling back to a single unkeyed slot when
 * no threadId is available) and re-resolved when within a 5-minute margin of
 * `expires_at` or on a 4xx session error.
 *
 * Pure over an injected fetch + now() so caching/expiry is unit-testable with
 * no network.
 */

/** Re-resolve a session when within this margin of its expiry. */
export const AUTO_SESSION_EXPIRY_MARGIN_MS = 5 * 60_000;

/** Max characters of the prompt forwarded to the auto selector. */
export const AUTO_PROMPT_MAX_CHARS = 4000;

export interface CopilotAutoSession {
	sessionToken: string;
	selectedModelId: string;
	/** Absolute epoch-ms when the session token expires. */
	expiresAt: number;
	selectionReason?: string;
}

interface RawAutoResponse {
	session_token?: string;
	selected_model?: { id?: string };
	expires_at?: number;
	selection_reason?: string;
}

/** Resolve a fresh auto-session from a prompt. The injected fetch carries auth. */
export async function resolveAutoSession(
	deps: { fetch: typeof fetch; apiEndpoint: string; now?: () => number },
	prompt: string,
): Promise<CopilotAutoSession> {
	const res = await deps.fetch(`${deps.apiEndpoint}/auto`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ prompt: prompt.slice(0, AUTO_PROMPT_MAX_CHARS) }),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Copilot auto-session failed: ${res.status} ${res.statusText} ${detail}`.trim(),
		);
	}
	const json = (await res.json()) as RawAutoResponse;
	if (!json.session_token || !json.selected_model?.id) {
		throw new Error("Copilot auto-session response is missing session_token or selected_model.id");
	}
	// expires_at is unix SECONDS; convert to epoch-ms.
	const expiresAt = json.expires_at ? json.expires_at * 1000 : (deps.now ?? Date.now)() + 600_000;
	return {
		sessionToken: json.session_token,
		selectedModelId: json.selected_model.id,
		expiresAt,
		selectionReason: json.selection_reason,
	};
}

/**
 * Caches auto-sessions keyed by threadId (a single unkeyed slot when no
 * threadId is present), re-resolving on expiry (within the margin). Single
 * entry point `get(threadId, prompt)`; `invalidate(threadId)` drops a session
 * after a 4xx session error so the next turn re-resolves.
 */
export class CopilotAutoSessionCache {
	private readonly sessions = new Map<string, CopilotAutoSession>();
	private inFlight = new Map<string, Promise<CopilotAutoSession>>();

	constructor(
		private readonly deps: { fetch: typeof fetch; apiEndpoint: string; now?: () => number },
	) {}

	private key(threadId: string | undefined): string {
		return threadId ?? "__default__";
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private valid(session: CopilotAutoSession | undefined): session is CopilotAutoSession {
		return !!session && this.now() < session.expiresAt - AUTO_SESSION_EXPIRY_MARGIN_MS;
	}

	/**
	 * Return a valid cached session for this thread, or resolve a fresh one.
	 * Single-flights concurrent resolutions for the same key.
	 */
	async get(threadId: string | undefined, prompt: string): Promise<CopilotAutoSession> {
		const key = this.key(threadId);
		const cached = this.sessions.get(key);
		if (this.valid(cached)) return cached;
		const pending = this.inFlight.get(key);
		if (pending) return pending;
		const promise = (async () => {
			try {
				const session = await resolveAutoSession(this.deps, prompt);
				this.sessions.set(key, session);
				return session;
			} finally {
				this.inFlight.delete(key);
			}
		})();
		this.inFlight.set(key, promise);
		return promise;
	}

	/** Drop a session (after a 4xx session error) so the next turn re-resolves. */
	invalidate(threadId: string | undefined): void {
		this.sessions.delete(this.key(threadId));
	}
}
