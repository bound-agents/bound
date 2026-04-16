/**
 * Microtask-based coalescer for batching WS frame sends.
 *
 * Collects items added during a synchronous code block.
 * When the current event loop tick completes (via queueMicrotask),
 * flushes all pending items in a single batch.
 *
 * Example: Multiple insertRow() calls in the same tick are coalesced
 * into one changelog_push frame instead of N frames.
 */
export class MicrotaskCoalescer<T> {
	private pending: T[] = [];
	private scheduled = false;

	constructor(private flush: (items: T[]) => void) {}

	/**
	 * Add an item to the pending batch.
	 * If this is the first item, schedules the flush via queueMicrotask.
	 */
	add(item: T): void {
		this.pending.push(item);
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => {
				const batch = this.pending;
				this.pending = [];
				this.scheduled = false;
				this.flush(batch);
			});
		}
	}

	/**
	 * Get the current count of pending items (for testing/diagnostics).
	 */
	get pendingCount(): number {
		return this.pending.length;
	}
}
