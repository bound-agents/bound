/**
 * TurnStateStore — a keyed cache for agent turn state that must survive
 * AgentLoop instance teardown (e.g. across client-tool defer/wakeup cycles)
 * while staying bounded in lifetime to match the upstream prompt-cache TTL.
 *
 * The interface is generic so @bound/core stays free of agent-internal types.
 * Default implementation is in-memory, scoped to process lifetime. When we
 * move to multi-node, swap this for a distributed implementation (Redis,
 * db-persisted with TTL column, or sticky-routing + local cache).
 */
export interface TurnStateStore<T = unknown> {
	get(threadId: string): T | undefined;
	set(threadId: string, state: T): void;
	delete(threadId: string): void;
}

interface Entry<T> {
	state: T;
	storedAt: number;
}

/**
 * In-memory TurnStateStore with TTL-based lazy eviction on read.
 *
 * TTL should be set SHORTER than the upstream prompt-cache TTL. Anthropic's
 * 5-minute cache refreshes on each read so practical lifetime exceeds 5m,
 * but we can't rely on that — if our store reports warm but the upstream
 * cache has evicted, we pay cache_write premiums for nothing. Conservative
 * defaults: 4 minutes for the 5m tier, 55 minutes for the 1h tier.
 */
export class InMemoryTurnStateStore<T> implements TurnStateStore<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly ttlMs: number;

	constructor(ttlMs = 4 * 60 * 1000) {
		this.ttlMs = ttlMs;
	}

	get(threadId: string): T | undefined {
		const entry = this.entries.get(threadId);
		if (!entry) return undefined;
		if (Date.now() - entry.storedAt > this.ttlMs) {
			this.entries.delete(threadId);
			return undefined;
		}
		return entry.state;
	}

	set(threadId: string, state: T): void {
		this.entries.set(threadId, { state, storedAt: Date.now() });
	}

	delete(threadId: string): void {
		this.entries.delete(threadId);
	}

	/** Test/debug helper — number of live entries (not evicted). */
	size(): number {
		return this.entries.size;
	}
}
