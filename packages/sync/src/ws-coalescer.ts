/** Batch items added in one event-loop turn into a single WebSocket send. */
export class MicrotaskCoalescer<T> {
	private pending: T[] = [];
	private scheduled = false;

	constructor(private flush: (items: T[]) => void) {}

	/** Add an item and schedule the batch flush if needed. */
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

	/** Current pending count, for tests and diagnostics. */
	get pendingCount(): number {
		return this.pending.length;
	}
}
