/** Logger surface the stale-binding reconcilers need; the relay-processor passes its own. */
export interface ReconcilerLogger {
	info: (msg: string, meta?: Record<string, unknown>) => void;
	warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Settle window shared by the stale-binding reconcilers. A healthy handler
 * drains its intake the moment it runs, and a handle synced ahead of its task
 * row (invariant #20) converges within a few sync cycles; 15 minutes clears
 * many scheduler ticks and sync cycles, so anything still stale is a dark
 * binding rather than a row mid-flight.
 */
export const RECONCILE_STALE_AFTER_MS = 15 * 60 * 1000;
