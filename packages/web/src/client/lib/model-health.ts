/**
 * Shared route-health vocabulary for the model picker, Settings › Models, and
 * the health dot. "degraded" (amber) means only backing-off / retrying routes
 * can serve; it is distinct from a model's fallback policy.
 */

export type ModelHealthState = "healthy" | "degraded" | "none" | "unknown";

export interface HealthRoute {
	drained: boolean;
	health: "healthy" | "backoff" | "half_open" | "unknown";
	next_trial_at?: number | null;
}

export const HEALTH_STATE_LABELS: Record<ModelHealthState, string> = {
	healthy: "Healthy",
	degraded: "Degraded",
	none: "No route available",
	unknown: "Unknown",
};
/** Model-level state: green if any live route is healthy, amber if only backoff/half-open, grey otherwise. */
export function modelHealthState(
	routes: readonly HealthRoute[] | null | undefined,
): ModelHealthState {
	if (!routes) return "unknown";
	const live = routes.filter((r) => !r.drained);
	if (live.length === 0) return "none";
	if (live.some((r) => r.health === "healthy")) return "healthy";
	if (live.some((r) => r.health === "backoff" || r.health === "half_open")) return "degraded";
	return "unknown";
}

/** Route-level label; `at` adds a retry countdown for backing-off routes. */
export function routeHealthLabel(r: HealthRoute, at?: number): string {
	if (r.drained) return "Disabled";
	if (r.health === "healthy") return "Healthy";
	if (r.health === "half_open") return "Retrying";
	if (r.health === "backoff") {
		if (at === undefined || !r.next_trial_at) return "Backing off";
		const secs = Math.max(0, Math.round((r.next_trial_at - at) / 1000));
		const span = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
		return `Backing off, retrying in ${span}`;
	}
	return "Unknown";
}
