/**
 * Polls `condition` every `intervalMs` (default 10ms) until it returns `true`
 * or `timeoutMs` (default 3000ms) is exceeded.
 *
 * Use this instead of fixed `setTimeout` sleeps in tests so they resolve as
 * soon as the observable side-effect appears rather than waiting a worst-case
 * wall-clock budget.
 *
 * @throws if the deadline passes without the condition being met.
 */
export async function waitFor(
	condition: () => boolean,
	opts?: { timeoutMs?: number; intervalMs?: number; message?: string },
): Promise<void> {
	const { timeoutMs = 3000, intervalMs = 10, message = "condition not met" } = opts ?? {};
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms: ${message}`);
		}
		await new Promise<void>((r) => setTimeout(r, intervalMs));
	}
}

/** Resolves after `ms` milliseconds. Use only for inherently time-dependent tests. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
