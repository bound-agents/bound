import { describe, expect, it } from "bun:test";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import type { LoopModelResolution } from "../extensions";
import {
	type LoopTurnDecision,
	ModularAgentLoop,
	type PreparedLoopFrame,
} from "../modular-agent-loop";
import type { AgentLoopConfig, AgentLoopState } from "../types";

/**
 * Behavioral coverage for the protected lifecycle hooks the ModularAgentLoop
 * exposes for host specialization: cancel(), the phase state-machine
 * (setPhase / enterPhaseOverlay / restorePhase), the default no-op observer
 * hooks (onPhaseChange / onInvalidPhaseTransition), the default onRouteFailure
 * (no fallback), and the construction-time abort check. These are reached
 * through a thin test subclass that promotes the protected members and records
 * the observable effects — phase transitions, abort state, and run outcomes.
 */

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function baseConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		threadId: "t-hooks",
		userId: "u-hooks",
		...overrides,
	} as AgentLoopConfig;
}

/** A backend that never gets called — the hook tests drive the loop methods directly. */
class UnusedBackend implements LLMBackend {
	// biome-ignore lint/correctness/useYield: deliberately never yields; never invoked
	async *chat(): AsyncIterable<StreamChunk> {
		throw new Error("chat() should not run in a hook test");
	}
	capabilities() {
		return {} as ReturnType<LLMBackend["capabilities"]>;
	}
}

/**
 * Promotes the protected surface under test and records phase-change /
 * invalid-transition observations so tests can assert the default hooks ran
 * and the overlay/restore helpers walk the phase correctly.
 */
class HookProbeLoop extends ModularAgentLoop {
	readonly phaseChanges: Array<[AgentLoopState, AgentLoopState]> = [];
	readonly invalidTransitions: Array<[AgentLoopState, AgentLoopState]> = [];

	protected resolveModel(): LoopModelResolution {
		return { kind: "error", error: "unused" };
	}
	protected async prepareFrame(): Promise<Omit<PreparedLoopFrame, "resolution">> {
		throw new Error("prepareFrame should not run in a hook test");
	}

	// Observe the default hooks by calling super from an override. The super
	// bodies are the uncovered no-ops; these wrappers record that they ran.
	protected onPhaseChange(previous: AgentLoopState, next: AgentLoopState): void {
		super.onPhaseChange(previous, next);
		this.phaseChanges.push([previous, next]);
	}
	protected onInvalidPhaseTransition(
		previous: AgentLoopState,
		next: AgentLoopState,
		allowed: readonly AgentLoopState[],
	): void {
		super.onInvalidPhaseTransition(previous, next, allowed);
		this.invalidTransitions.push([previous, next]);
	}

	// Promote protected members for assertion.
	get isAborted(): boolean {
		return this.aborted;
	}
	get currentPhase(): AgentLoopState {
		return this.phase;
	}
	callSetPhase(next: AgentLoopState, options?: { validate?: boolean }): void {
		this.setPhase(next, options);
	}
	callEnterOverlay(overlay: AgentLoopState): AgentLoopState {
		return this.enterPhaseOverlay(overlay);
	}
	callRestorePhase(previous: AgentLoopState): void {
		this.restorePhase(previous);
	}
	async callOnRouteFailure(
		error: unknown,
		frame: PreparedLoopFrame,
	): Promise<LoopTurnDecision | null> {
		return this.onRouteFailure(error, frame);
	}
}

function makeProbe(config: AgentLoopConfig = baseConfig()): HookProbeLoop {
	return new HookProbeLoop({ logger: noopLogger }, config, {});
}

describe("ModularAgentLoop.cancel", () => {
	it("flips the loop into the aborted state", () => {
		const loop = makeProbe();
		expect(loop.isAborted).toBe(false);
		loop.cancel();
		expect(loop.isAborted).toBe(true);
	});
});

describe("ModularAgentLoop construction abort check", () => {
	it("starts aborted when handed an already-aborted signal", () => {
		const controller = new AbortController();
		controller.abort();
		const loop = makeProbe(baseConfig({ abortSignal: controller.signal }));
		expect(loop.isAborted).toBe(true);
	});

	it("flips to aborted when a live signal fires after construction", () => {
		const controller = new AbortController();
		const loop = makeProbe(baseConfig({ abortSignal: controller.signal }));
		expect(loop.isAborted).toBe(false);
		controller.abort();
		expect(loop.isAborted).toBe(true);
	});

	it("stays un-aborted with no signal supplied", () => {
		const loop = makeProbe();
		expect(loop.isAborted).toBe(false);
	});
});

describe("ModularAgentLoop.setPhase", () => {
	it("advances along a valid transition and notifies onPhaseChange", () => {
		const loop = makeProbe();
		expect(loop.currentPhase).toBe("IDLE");
		loop.callSetPhase("HYDRATE_FS");
		expect(loop.currentPhase).toBe("HYDRATE_FS");
		expect(loop.phaseChanges).toContainEqual(["IDLE", "HYDRATE_FS"]);
		// A valid transition does not record an invalid one.
		expect(loop.invalidTransitions).toHaveLength(0);
	});

	it("reports an invalid transition but still moves the phase", () => {
		const loop = makeProbe();
		// IDLE only permits HYDRATE_FS; LLM_CALL is not allowed from IDLE.
		loop.callSetPhase("LLM_CALL");
		expect(loop.invalidTransitions).toContainEqual(["IDLE", "LLM_CALL"]);
		// The default onInvalidPhaseTransition is a no-op observer; the phase
		// transition itself is not blocked.
		expect(loop.currentPhase).toBe("LLM_CALL");
		expect(loop.phaseChanges).toContainEqual(["IDLE", "LLM_CALL"]);
	});

	it("skips transition validation when validate:false is passed", () => {
		const loop = makeProbe();
		loop.callSetPhase("TOOL_EXECUTE", { validate: false });
		expect(loop.invalidTransitions).toHaveLength(0);
		expect(loop.currentPhase).toBe("TOOL_EXECUTE");
		expect(loop.phaseChanges).toContainEqual(["IDLE", "TOOL_EXECUTE"]);
	});
});

describe("ModularAgentLoop phase overlay", () => {
	it("enters an overlay without validation and restores the prior phase", () => {
		const loop = makeProbe();
		loop.callSetPhase("HYDRATE_FS");
		loop.callSetPhase("ASSEMBLE_CONTEXT");
		expect(loop.currentPhase).toBe("ASSEMBLE_CONTEXT");

		// Overlay to an otherwise-illegal phase; enterPhaseOverlay must not flag
		// it as invalid and must return the phase it displaced.
		const displaced = loop.callEnterOverlay("RELAY_WAIT");
		expect(displaced).toBe("ASSEMBLE_CONTEXT");
		expect(loop.currentPhase).toBe("RELAY_WAIT");
		expect(loop.invalidTransitions).toHaveLength(0);

		loop.callRestorePhase(displaced);
		expect(loop.currentPhase).toBe("ASSEMBLE_CONTEXT");
		// Restore is also unvalidated — no invalid transition recorded.
		expect(loop.invalidTransitions).toHaveLength(0);
	});
});

describe("ModularAgentLoop.onRouteFailure default", () => {
	it("returns null, signaling no host-provided fallback", async () => {
		const loop = makeProbe();
		const frame = { resolution: { modelId: "mock" } } as unknown as PreparedLoopFrame;
		const decision = await loop.callOnRouteFailure(new Error("429 rate limited"), frame);
		expect(decision).toBeNull();
	});
});

describe("ModularAgentLoop.run default beforeRun/afterRun", () => {
	it("runs the default lifecycle hooks and surfaces model-resolution failure", async () => {
		// resolveModel returns an error, so run() exits via the
		// model-resolution-failed path having invoked the default beforeRun()
		// and afterRun() no-ops along the way.
		const alerts: string[] = [];
		class ResolutionFailLoop extends HookProbeLoop {
			protected persistAlert(content: string): void {
				alerts.push(content);
			}
		}
		const loop = new ResolutionFailLoop({ logger: noopLogger }, baseConfig(), {});
		// Ensure the backend reference is never touched.
		void new UnusedBackend();

		const result = await loop.run();
		expect(result.outcome).toBe("model-resolution-failed");
		expect(result.error).toBe("unused");
		expect(alerts).toContainEqual("Loop error: unused");
	});
});
