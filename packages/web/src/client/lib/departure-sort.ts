interface DepartureTask {
	id: string;
	status: string;
	next_run_at: string | null;
}

export function rankDepartures(tasks: DepartureTask[], limit = 6): DepartureTask[] {
	return [...tasks]
		.filter((t) => t.status !== "completed" && t.status !== "cancelled")
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
