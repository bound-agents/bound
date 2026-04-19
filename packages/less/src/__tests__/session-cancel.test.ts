import { beforeEach, describe, expect, it, vi } from "bun:test";
import { type CancelDeps, CancelStateMachine } from "../session/cancel";

/**
 * Test AC7.7-AC7.11: Ctrl-C cancellation state machine.
 */
describe("CancelStateMachine", () => {
	let deps: CancelDeps;
	let stateMachine: CancelStateMachine;

	beforeEach(() => {
		deps = {
			cancelThread: vi.fn(async () => {}),
			abortInFlightTools: vi.fn(),
			gracefulExit: vi.fn(async () => {}),
			dismissModal: vi.fn(() => false),
			showHint: vi.fn(),
		};

		stateMachine = new CancelStateMachine("thread1", deps);
	});

	describe("AC7.7: Ctrl-C during active turn", () => {
		it("calls cancelThread and abortInFlightTools once on first Ctrl-C", async () => {
			stateMachine.turnActive = true;

			await stateMachine.onCtrlC();

			expect(deps.cancelThread).toHaveBeenCalledTimes(1);
			expect(deps.cancelThread).toHaveBeenCalledWith("thread1");
			expect(deps.abortInFlightTools).toHaveBeenCalledTimes(1);
		});

		it("does not call cancelThread again if already canceled this turn", async () => {
			stateMachine.turnActive = true;

			await stateMachine.onCtrlC();
			await stateMachine.onCtrlC();

			expect(deps.cancelThread).toHaveBeenCalledTimes(1);
			expect(deps.abortInFlightTools).toHaveBeenCalledTimes(1);
		});
	});

	describe("AC7.8: Double Ctrl-C within 2s exits gracefully", () => {
		it("calls gracefulExit on second Ctrl-C within 2s during turn", async () => {
			stateMachine.turnActive = true;

			await stateMachine.onCtrlC();
			// Simulate second press within 2s by setting lastCtrlCTime to recent past
			(stateMachine as any).lastCtrlCTime = Date.now() - 1000;

			await stateMachine.onCtrlC();

			expect(deps.gracefulExit).toHaveBeenCalledTimes(1);
		});

		it("does not call gracefulExit if outside 2s window", async () => {
			stateMachine.turnActive = true;

			await stateMachine.onCtrlC();
			// Simulate press outside 2s window
			(stateMachine as any).lastCtrlCTime = Date.now() - 2100;

			await stateMachine.onCtrlC();

			expect(deps.gracefulExit).not.toHaveBeenCalled();
		});
	});

	describe("AC7.9: Idle first press shows hint, second within 2s exits", () => {
		it("shows hint on first Ctrl-C when idle", async () => {
			stateMachine.turnActive = false;

			await stateMachine.onCtrlC();

			expect(deps.showHint).toHaveBeenCalled();
			expect(deps.gracefulExit).not.toHaveBeenCalled();
		});

		it("exits on second Ctrl-C within 2s when idle", async () => {
			stateMachine.turnActive = false;

			await stateMachine.onCtrlC();
			// Simulate second press within 2s
			(stateMachine as any).lastCtrlCTime = Date.now() - 1000;

			await stateMachine.onCtrlC();

			expect(deps.gracefulExit).toHaveBeenCalledTimes(1);
		});
	});

	describe("AC7.10: Ctrl-C while modal open dismisses modal", () => {
		it("dismisses modal without counting toward exit", async () => {
			stateMachine.modalOpen = true;
			// Mock dismissModal to return true (modal was open)
			deps.dismissModal = vi.fn(() => true);

			await stateMachine.onCtrlC();

			expect(deps.dismissModal).toHaveBeenCalled();
			expect(deps.showHint).not.toHaveBeenCalled();
			expect(deps.gracefulExit).not.toHaveBeenCalled();
		});

		it("does not increment Ctrl-C counter when dismissing modal", async () => {
			stateMachine.modalOpen = true;
			deps.dismissModal = vi.fn(() => true);

			// First Ctrl-C dismisses modal
			await stateMachine.onCtrlC();

			// Now show hint on idle (press after modal should reset the 2s window)
			stateMachine.turnActive = false;
			// Reset lastCtrlCTime to simulate a fresh press
			(stateMachine as any).lastCtrlCTime = 0;

			await stateMachine.onCtrlC();

			expect(deps.showHint).toHaveBeenCalled();
		});
	});

	describe("AC7.11: Ctrl-C during transition deferred", () => {
		it("sets deferred flag when transition in flight", async () => {
			stateMachine.transitionInFlight = true;

			await stateMachine.onCtrlC();

			expect(deps.showHint).not.toHaveBeenCalled();
			expect(deps.cancelThread).not.toHaveBeenCalled();
			expect(deps.gracefulExit).not.toHaveBeenCalled();
		});
	});

	describe("resetTurn", () => {
		it("clears canceled flag and turns off turnActive", () => {
			stateMachine.turnActive = true;

			// Simulate a cancellation
			(stateMachine as any).canceledThisTurn = true;

			stateMachine.resetTurn();

			expect(stateMachine.turnActive).toBe(false);
			expect((stateMachine as any).canceledThisTurn).toBe(false);
		});
	});

	describe("onTransitionSettled", () => {
		it("clears transitionInFlight flag", async () => {
			stateMachine.transitionInFlight = true;

			await stateMachine.onTransitionSettled();

			expect(stateMachine.transitionInFlight).toBe(false);
		});

		it("processes deferred Ctrl-C when transition settles", async () => {
			stateMachine.transitionInFlight = true;
			(stateMachine as any).deferredCtrlC = true;
			stateMachine.turnActive = true;

			await stateMachine.onTransitionSettled();

			expect(deps.cancelThread).toHaveBeenCalled();
			expect((stateMachine as any).deferredCtrlC).toBe(false);
		});

		it("does nothing if no deferred Ctrl-C", async () => {
			stateMachine.transitionInFlight = true;

			await stateMachine.onTransitionSettled();

			expect(deps.cancelThread).not.toHaveBeenCalled();
		});
	});

	describe("state transitions", () => {
		it("handles multiple state transitions correctly", async () => {
			// Start idle
			expect(stateMachine.turnActive).toBe(false);

			// Turn starts
			stateMachine.turnActive = true;
			await stateMachine.onCtrlC();
			expect(deps.cancelThread).toHaveBeenCalledTimes(1);

			// Reset between turns
			stateMachine.resetTurn();
			expect(stateMachine.turnActive).toBe(false);

			// Turn again
			stateMachine.turnActive = true;
			await stateMachine.onCtrlC();
			expect(deps.cancelThread).toHaveBeenCalledTimes(2);
		});

		it("allows Ctrl-C in idle after being active", async () => {
			// Active turn with Ctrl-C
			stateMachine.turnActive = true;
			await stateMachine.onCtrlC();

			// Reset after turn
			stateMachine.resetTurn();

			// Reset lastCtrlCTime so next press is considered "first" in idle
			(stateMachine as any).lastCtrlCTime = 0;

			// Now idle, first Ctrl-C shows hint
			await stateMachine.onCtrlC();
			expect(deps.showHint).toHaveBeenCalled();
		});
	});
});
