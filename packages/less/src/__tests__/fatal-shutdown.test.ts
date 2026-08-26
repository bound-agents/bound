import { describe, expect, it } from "bun:test";
import { shutdownBeforeFatalExit } from "../boundless";

describe("boundless fatal shutdown", () => {
	it("awaits telemetry shutdown before exiting", async () => {
		const calls: string[] = [];
		await shutdownBeforeFatalExit(
			async () => {
				await Promise.resolve();
				calls.push("shutdown");
			},
			(code) => calls.push(`exit:${code}`),
		);
		expect(calls).toEqual(["shutdown", "exit:1"]);
	});

	it("still exits when telemetry shutdown fails", async () => {
		const calls: string[] = [];
		await shutdownBeforeFatalExit(
			async () => {
				calls.push("shutdown");
				throw new Error("export failed");
			},
			(code) => calls.push(`exit:${code}`),
		);
		expect(calls).toEqual(["shutdown", "exit:1"]);
	});
});
