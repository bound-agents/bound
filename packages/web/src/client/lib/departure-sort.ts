interface DepartureTask {
	id: string;
	status: string;
	next_run_at: string | null;
}

function isActiveOrUpcoming(t: DepartureTask): boolean {
	if (t.status === "completed" || t.status === "cancelled") return false;
	if (t.status === "running" || t.status === "claimed") return true;
	if (!t.next_run_at) return false;
	return new Date(t.next_run_at).getTime() > Date.now();
}

export function rankDepartures(tasks: DepartureTask[], limit = 6): DepartureTask[] {
	return [...tasks]
		.filter(isActiveOrUpcoming)
		.sort((a, b) => {
			const aActive = a.status === "running" || a.status === "claimed" ? 0 : 1;
			const bActive = b.status === "running" || b.status === "claimed" ? 0 : 1;

			if (aActive !== bActive) return aActive - bActive;

			const aNext = a.next_run_at ? new Date(a.next_run_at).getTime() : Number.POSITIVE_INFINITY;
			const bNext = b.next_run_at ? new Date(b.next_run_at).getTime() : Number.POSITIVE_INFINITY;

			return aNext - bNext;
		})
		.slice(0, limit);
}
