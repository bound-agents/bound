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

export function waitForSnapshotChunks<T>(
	observe: () => T[],
	minimumCount = 1,
	timeoutMs?: number,
): Promise<T[]> {
	return waitFor({
		description: `at least ${minimumCount} received snapshot chunk${minimumCount === 1 ? "" : "s"}`,
		observe,
		isReady: (chunks) => chunks.length >= minimumCount,
		timeoutMs,
	});
}

export async function waitForPersistedSnapshotState<T>(
	observe: () => T | null,
	timeoutMs?: number,
): Promise<T> {
	const state = await waitFor({
		description: "persisted snapshot state",
		observe,
		isReady: (observed) => observed !== null,
		timeoutMs,
	});
	// `waitFor` only returns once isReady held, so the null branch is
	// unreachable here; the narrowing is lost because waitFor's isReady is
	// plain-boolean, not a type guard.
	return state as T;
}

export function waitForConnectionTransition<T>(
	observe: () => T,
	isReady: (state: T) => boolean,
	timeoutMs?: number,
): Promise<T> {
	return waitFor({
		description: "connection/retry transition",
		observe,
		isReady,
		timeoutMs,
	});
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
