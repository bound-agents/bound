export const STATUS_WEIGHT = {
	running: 0,
	failed: 1,
	pending: 2,
	claimed: 2,
	cancelled: 3,
	completed: 4,
} as const;

interface Task {
	id: string;
	status: keyof typeof STATUS_WEIGHT;
	next_run_at: string | null;
	last_run_at: string | null;
}

export function sortTasks(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		// Primary sort: by status weight
		const aWeight = STATUS_WEIGHT[a.status];
		const bWeight = STATUS_WEIGHT[b.status];

		if (aWeight !== bWeight) {
			return aWeight - bWeight;
		}

		// Secondary sort: by next_run_at ascending (nulls to end)
		const aNext = a.next_run_at ? new Date(a.next_run_at).getTime() : Number.POSITIVE_INFINITY;
		const bNext = b.next_run_at ? new Date(b.next_run_at).getTime() : Number.POSITIVE_INFINITY;

		if (aNext !== bNext) {
			return aNext - bNext;
		}

		// Tertiary sort: by last_run_at descending (nulls to end)
		const aLast = a.last_run_at ? new Date(a.last_run_at).getTime() : Number.NEGATIVE_INFINITY;
		const bLast = b.last_run_at ? new Date(b.last_run_at).getTime() : Number.NEGATIVE_INFINITY;

		return bLast - aLast;
	});
}
