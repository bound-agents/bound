interface ReachabilityState {
	reachable: boolean;
	failureCount: number;
}

export class ReachabilityTracker {
	private states = new Map<string, ReachabilityState>();
	private readonly maxFailures: number;

	constructor(maxFailures = 3) {
		this.maxFailures = maxFailures;
	}

	isReachable(siteId: string): boolean {
		const state = this.states.get(siteId);
		if (!state) return true; // Unknown hosts assumed reachable
		return state.reachable;
	}

	recordFailure(siteId: string): void {
		const state = this.states.get(siteId) ?? { reachable: true, failureCount: 0 };
		state.failureCount++;
		if (state.failureCount >= this.maxFailures) {
			state.reachable = false;
		}
		this.states.set(siteId, state);
	}

	recordSuccess(siteId: string): void {
		this.states.set(siteId, { reachable: true, failureCount: 0 });
	}

	getState(siteId: string): ReachabilityState | undefined {
		return this.states.get(siteId);
	}
}
