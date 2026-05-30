import { describe, expect, it } from "bun:test";
import { isConnectivityFailure } from "../scheduler";

// #67: tasks that require a remote model fail repeatedly while the host is
// disconnected from the internet (or the relay/inference host is unreachable).
// Those failures are expected and self-resolve, so we must NOT file a
// "task failed N times" advisory for each one — that floods the operator with
// unactionable noise. `isConnectivityFailure` is the gate that distinguishes
// environmental connectivity errors from genuine task-config / logic faults.
describe("isConnectivityFailure (#67)", () => {
	describe("classifies connectivity / remote-availability errors as transient", () => {
		const transient = [
			// relay-router.ts:220 — model can't resolve to any reachable remote host
			'Model "opus" not available on any remote host',
			// relay-router.ts:90 — tool can't resolve to any reachable remote host
			'Tool "github" not available on any remote host',
			// relay-stream$.ts:291 — relay inference timed out across all hosts
			"inference-relay.AC1.5: all 2 eligible host(s) timed out",
			// raw network failures surfaced by direct cloud (Bedrock/Anthropic) calls
			"fetch failed",
			"getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com",
			"getaddrinfo EAI_AGAIN api.anthropic.com",
			"connect ECONNREFUSED 127.0.0.1:443",
			"read ECONNRESET",
			"connect ETIMEDOUT",
			"socket hang up",
			"network error while connecting",
			"Unable to connect to the remote host",
			"Connection refused",
		];
		for (const error of transient) {
			it(`treats ${JSON.stringify(error.slice(0, 48))} as connectivity`, () => {
				expect(isConnectivityFailure(error)).toBe(true);
			});
		}
	});

	describe("does NOT suppress genuine task-config / logic failures", () => {
		const genuine = [
			'Unknown model "glm-4.7"',
			"Task threw: TypeError: cannot read property 'x' of undefined",
			"Tool execution failed: invalid arguments",
			"Empty payload — nothing to do",
			"messages parameter illegal (1214)",
			"Validation error: model_hint references a decommissioned model",
			"",
		];
		for (const error of genuine) {
			it(`treats ${JSON.stringify(error.slice(0, 48))} as actionable`, () => {
				expect(isConnectivityFailure(error)).toBe(false);
			});
		}
	});

	it("is case-insensitive", () => {
		expect(isConnectivityFailure('MODEL "opus" NOT AVAILABLE ON ANY REMOTE HOST')).toBe(true);
		expect(isConnectivityFailure("Fetch Failed")).toBe(true);
	});
});
