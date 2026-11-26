export interface WaitForOptions<T> {
	description: string;
	observe: () => T;
	isReady: (observed: T) => boolean;
	timeoutMs?: number;
	intervalMs?: number;
}

function formatObservedState(observed: unknown): string {
	try {
		return JSON.stringify(observed);
	} catch {
		return String(observed);
	}
}

/**
 * Wait for a predicate over externally-observable test state. The final observed
 * value is included in timeout errors so a stalled protocol transition is debuggable.
 */
export async function waitFor<T>({
	description,
	observe,
	isReady,
	timeoutMs = 1_000,
	intervalMs = 1,
}: WaitForOptions<T>): Promise<T> {
	const startedAt = Date.now();
	let observed = observe();
	while (!isReady(observed)) {
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= timeoutMs) {
			throw new Error(
				`Timed out waiting for ${description} after ${timeoutMs}ms; observed: ${formatObservedState(observed)}`,
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
		observed = observe();
	}
	return observed;
}

export function waitForCompletedRowPull<T>(
	observe: () => T,
	isComplete: (state: T) => boolean,
	timeoutMs?: number,
): Promise<T> {
	return waitFor({
		description: "a completed row pull",
		observe,
		isReady: isComplete,
		timeoutMs,
	});
}
