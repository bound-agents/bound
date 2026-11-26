import type { Observable } from "rxjs";

/**
 * Bridges an RxJS Observable into an AsyncIterable, buffering values that
 * arrive between pulls. Errors surface on the awaiting pull; completion ends
 * iteration; early break or throw unsubscribes. `undefined` values are dropped.
 */
export function observableToAsyncIterable<T>(source: Observable<T>): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator]() {
			const queue: T[] = [];
			let completed = false;
			let error: unknown;
			let wake: (() => void) | undefined;
			const notify = () => {
				wake?.();
				wake = undefined;
			};
			const subscription = source.subscribe({
				next(value) {
					queue.push(value);
					notify();
				},
				error(err) {
					error = err;
					completed = true;
					notify();
				},
				complete() {
					completed = true;
					notify();
				},
			});
			try {
				while (!completed || queue.length > 0) {
					if (queue.length > 0) {
						const value = queue.shift();
						if (value !== undefined) {
							yield value;
						}
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					if (error !== undefined) {
						throw error;
					}
				}
				if (error !== undefined) {
					throw error;
				}
			} finally {
				subscription.unsubscribe();
			}
		},
	};
}
