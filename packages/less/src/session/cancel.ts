/**
 * Ctrl-C cancellation state machine.
 * Implements AC7.7-AC7.11: Modal handling, transition deferral, two-press exit.
 */

export interface CancelDeps {
	cancelThread: (threadId: string) => Promise<void>;
	abortInFlightTools: () => void;
	gracefulExit: () => Promise<void>;
	dismissModal: () => boolean; // returns true if modal was open and dismissed
	showHint: (message: string) => void;
}

/**
 * CancelStateMachine manages Ctrl-C handling with the following state machine:
 *
 * States:
 * - turnActive: boolean - whether an agent turn is currently running
 * - modalOpen: boolean - whether a modal dialog is open
 * - transitionInFlight: boolean - whether a thread transition is in progress
 * - canceledThisTurn: boolean - whether we already called cancel for this turn
 * - lastCtrlCTime: number - timestamp of last Ctrl-C press
 * - deferredCtrlC: boolean - whether a Ctrl-C was deferred during transition
 *
 * Behavior:
 * 1. Modal open (AC7.10): Dismiss modal, do not count toward exit sequence
 * 2. Transition in flight (AC7.11): Defer the Ctrl-C until transition settles
 * 3. Active turn, first press (AC7.7): Cancel thread and abort tools
 * 4. Active turn, second press within 2s (AC7.8): Exit gracefully
 * 5. Idle, first press (AC7.9): Show hint
 * 6. Idle, second press within 2s (AC7.9): Exit gracefully
 */
export class CancelStateMachine {
	private lastCtrlCTime = 0;
	private canceledThisTurn = false;
	private deferredCtrlC = false;

	turnActive = false;
	modalOpen = false;
	transitionInFlight = false;

	constructor(
		private threadId: string,
		private deps: CancelDeps,
	) {}

	/**
	 * Handle Ctrl-C press. Implements the full state machine.
	 */
	async onCtrlC(): Promise<void> {
		// AC7.10: Modal open - dismiss and return (doesn't count toward exit)
		if (this.modalOpen) {
			const wasDismissed = this.deps.dismissModal();
			if (wasDismissed) {
				this.modalOpen = false;
				return;
			}
		}

		// AC7.11: Transition in flight - defer and return
		if (this.transitionInFlight) {
			this.deferredCtrlC = true;
			return;
		}

		const now = Date.now();
		const withinTwoSeconds = now - this.lastCtrlCTime < 2000;

		if (this.turnActive) {
			// Active turn path
			if (!this.canceledThisTurn) {
				// AC7.7: First press during turn - cancel and abort
				await this.deps.cancelThread(this.threadId);
				this.deps.abortInFlightTools();
				this.canceledThisTurn = true;
				this.lastCtrlCTime = now;
			} else if (withinTwoSeconds) {
				// AC7.8: Second press within 2s - exit gracefully
				await this.deps.gracefulExit();
			}
		} else {
			// Idle path
			if (withinTwoSeconds) {
				// AC7.9: Second press within 2s - exit gracefully
				await this.deps.gracefulExit();
			} else {
				// AC7.9: First press - show hint
				this.deps.showHint("Press Ctrl-C again to exit");
				this.lastCtrlCTime = now;
			}
		}
	}

	/**
	 * Called when an agent turn completes.
	 * Resets canceled flag so next turn can handle Ctrl-C.
	 */
	resetTurn(): void {
		this.canceledThisTurn = false;
		this.turnActive = false;
	}

	/**
	 * Called when a transition completes or fails.
	 * If a Ctrl-C was deferred, process it now.
	 */
	async onTransitionSettled(): Promise<void> {
		this.transitionInFlight = false;

		if (this.deferredCtrlC) {
			this.deferredCtrlC = false;
			await this.onCtrlC();
		}
	}
}
