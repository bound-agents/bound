/**
 * #201: A simple counting semaphore to cap concurrent auxiliary-agent
 * invocations. Extracted from agent-factory.ts so the cap logic is
 * unit-testable without spinning up a full loop.
 *
 * The semaphore is per-host (lives in the agent-factory closure) and
 * shared across all invocations on that host. When the cap is reached,
 * acquire() returns false instead of blocking — the caller returns an
 * error to the agent rather than queuing indefinitely.
 */
export class ConcurrentCap {
	private active = 0;
	constructor(private readonly max: number) {}

	/** Returns true if a slot was acquired, false if the cap is reached. */
	acquire(): boolean {
		if (this.active >= this.max) return false;
		this.active++;
		return true;
	}

	release(): void {
		if (this.active > 0) this.active--;
	}

	get current(): number {
		return this.active;
	}

	get capacity(): number {
		return this.max;
	}
}
