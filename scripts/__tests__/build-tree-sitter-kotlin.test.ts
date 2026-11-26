import { describe, expect, it } from "bun:test";
import { runBuildWithRetries } from "../build-tree-sitter-kotlin";

// CI job 140211925352 (macos-latest) died in postinstall because node-gyp's
// one header-tarball fetch from nodejs.org hit ECONNREFUSED. A single network
// blip must not fail `bun install`; a persistent failure still must.
describe("runBuildWithRetries", () => {
	const noSleep = async () => {};

	it("returns 0 without retrying when the first build succeeds", async () => {
		let calls = 0;
		const code = await runBuildWithRetries(
			async () => {
				calls++;
				return 0;
			},
			{ attempts: 3, delayMs: 1, sleep: noSleep },
		);
		expect(code).toBe(0);
		expect(calls).toBe(1);
	});

	it("retries a failed build and succeeds on a later attempt", async () => {
		const codes = [1, 1, 0];
		const delays: number[] = [];
		const code = await runBuildWithRetries(async () => codes.shift() ?? 1, {
			attempts: 3,
			delayMs: 100,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		expect(code).toBe(0);
		expect(codes).toEqual([]);
		expect(delays).toEqual([100, 200]);
	});

	it("returns the last non-zero exit code once attempts are exhausted", async () => {
		let calls = 0;
		const code = await runBuildWithRetries(
			async () => {
				calls++;
				return calls === 3 ? 7 : 1;
			},
			{ attempts: 3, delayMs: 1, sleep: noSleep },
		);
		expect(code).toBe(7);
		expect(calls).toBe(3);
	});
});
