<script lang="ts">
// The web-chat consent card for pending MCP OAuth challenges (R-MO27c).
//
// A pending challenge is an unmet authorization demand for an http MCP server.
// This card enumerates the pending challenges (GET /api/mcp-challenges) and,
// under a LOOPBACK web bind, offers a live "Authorize" affordance that claims
// the challenge through the resolver bridge and opens the minted authorize URL
// in a new tab. Under a NON-loopback bind (the documented hub setting) a
// loopback redirect_uri is unreachable from a remote browser, so the card
// carries NO authorize button and instead shows the CLI instruction
// (`bound login --challenge <id>`).

interface PendingChallenge {
	challengeId: string;
	serverName: string;
	scopeDemand: string;
	failureReason: string | null;
}

interface ChallengesResponse {
	challenges: PendingChallenge[];
	loopback: boolean;
	canResolve: boolean;
}

let challenges = $state<PendingChallenge[]>([]);
let loopback = $state(false);
let canResolve = $state(false);
let loaded = $state(false);
let error = $state<string | null>(null);
// Per-challenge inline error/status while a claim is in flight.
let claimState = $state<Record<string, "claiming" | { error: string }>>({});

async function load(): Promise<void> {
	try {
		const res = await fetch("/api/mcp-challenges");
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(body.error ?? `request failed (${res.status})`);
		}
		const data = (await res.json()) as ChallengesResponse;
		challenges = data.challenges;
		loopback = data.loopback;
		canResolve = data.canResolve;
		error = null;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		loaded = true;
	}
}

async function authorize(id: string): Promise<void> {
	claimState = { ...claimState, [id]: "claiming" };
	try {
		const res = await fetch(`/api/mcp-challenges/${encodeURIComponent(id)}/claim`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		const body = (await res.json().catch(() => ({}))) as {
			authorizeUrl?: string;
			error?: string;
		};
		if (!res.ok || !body.authorizeUrl) {
			throw new Error(body.error ?? `claim failed (${res.status})`);
		}
		// Open the minted authorize URL — its loopback redirect_uri names this
		// same daemon's canonical callback, and the browser is on that machine.
		window.open(body.authorizeUrl, "_blank", "noopener");
		const { [id]: _dropped, ...rest } = claimState;
		claimState = rest;
	} catch (e) {
		claimState = { ...claimState, [id]: { error: e instanceof Error ? e.message : String(e) } };
	}
}

$effect(() => {
	void load();
});
</script>

{#if loaded && challenges.length > 0}
	<section class="challenge-list" aria-label="Pending MCP authorizations">
		{#each challenges as ch (ch.challengeId)}
			<article class="challenge">
				<header>
					<span class="lock" aria-hidden="true">🔐</span>
					<span class="title">Authorization required</span>
					<span class="server">{ch.serverName}</span>
				</header>
				<p class="scope">
					{#if ch.scopeDemand}
						Scopes: <code>{ch.scopeDemand}</code>
					{:else}
						The server requires authorization.
					{/if}
				</p>
				{#if ch.failureReason}
					<p class="failure">Previous attempt failed: {ch.failureReason}</p>
				{/if}
				<div class="actions">
					{#if loopback && canResolve}
						<button
							type="button"
							onclick={() => authorize(ch.challengeId)}
							disabled={claimState[ch.challengeId] === "claiming"}
						>
							{claimState[ch.challengeId] === "claiming" ? "Opening…" : "Authorize"}
						</button>
					{:else}
						<div class="cli-instruction">
							Resolve from a local session:
							<code>bound login --challenge {ch.challengeId}</code>
						</div>
					{/if}
				</div>
				{#if claimState[ch.challengeId] && typeof claimState[ch.challengeId] === "object"}
					<p class="claim-error">
						{(claimState[ch.challengeId] as { error: string }).error}
					</p>
				{/if}
				<footer class="challenge-id">challenge {ch.challengeId}</footer>
			</article>
		{/each}
	</section>
{:else if error}
	<p class="challenge-error">Could not load pending authorizations: {error}</p>
{/if}

<style>
	.challenge-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.challenge {
		border: 1px solid var(--line-T, #888);
		border-radius: 6px;
		padding: 0.75rem;
		background: var(--surface-1, transparent);
	}
	header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 600;
	}
	.server {
		font-family: var(--mono, monospace);
		color: var(--ink-2, inherit);
	}
	.scope,
	.failure,
	.claim-error {
		margin: 0.4rem 0 0;
		font-size: 0.9em;
	}
	.failure,
	.claim-error {
		color: var(--err, #c00);
	}
	.actions {
		margin-top: 0.6rem;
	}
	.cli-instruction {
		font-size: 0.9em;
		color: var(--ink-3, inherit);
	}
	code {
		font-family: var(--mono, monospace);
	}
	.challenge-id {
		margin-top: 0.5rem;
		font-size: 0.8em;
		color: var(--ink-3, #999);
		font-family: var(--mono, monospace);
	}
</style>
