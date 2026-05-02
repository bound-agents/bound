interface DepartureTask {
	id: string;
	status: string;
	next_run_at: string | null;
}

const DEPARTURE_STATUS_WEIGHT: Record<string, number> = {
	running: 0,
	claimed: 1,
	failed: 2,
	pending: 3,
};

export function rankDepartures(tasks: DepartureTask[], limit = 6): DepartureTask[] {
	return [...tasks]
		.filter((t) => t.status !== "completed" && t.status !== "cancelled")
		.sort((a, b) => {
			const wa = DEPARTURE_STATUS_WEIGHT[a.status] ?? 9;
			const wb = DEPARTURE_STATUS_WEIGHT[b.status] ?? 9;

			if (wa !== wb) return wa - wb;

			const aNext = a.next_run_at ? new Date(a.next_run_at).getTime() : Number.POSITIVE_INFINITY;
			const bNext = b.next_run_at ? new Date(b.next_run_at).getTime() : Number.POSITIVE_INFINITY;

			return aNext - bNext;
		})
		.slice(0, limit);
}
