import { describe, expect, it } from "bun:test";
import type { ModelResolution } from "../model-resolution";
import { waitForModelResolution } from "../model-resolution";

const unavailable: ModelResolution = {
	kind: "error",
	error: 'Model "remote" not available on any remote host',
	reason: "transient-unavailable",
};

const remote: ModelResolution = {
	kind: "remote",
	modelId: "remote",
	hosts: [
		{
			site_id: "remote-site",
			host_name: "remote",
			sync_url: null,
			online_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
			capabilities: { max_context: 128_000 },
		},
	],
	max_context: 128_000,
};

describe("waitForModelResolution", () => {
	it("retries a transiently unavailable remote model until its host reconnects", async () => {
		let attempts = 0;
		const resolution = await waitForModelResolution({
			initial: unavailable,
			resolve: () => {
				attempts++;
				return attempts === 2 ? remote : unavailable;
			},
			timeoutMs: 1_000,
			pollIntervalMs: 1,
		});

		expect(resolution).toBe(remote);
		expect(attempts).toBe(2);
	});

	it("does not wait for a permanently unknown model", async () => {
		let attempts = 0;
		const unknown: ModelResolution = {
			kind: "error",
			error: 'Unknown model "gone"',
			reason: "unknown-model",
		};

		const resolution = await waitForModelResolution({
			initial: unknown,
			resolve: () => {
				attempts++;
				return remote;
			},
			timeoutMs: 1_000,
			pollIntervalMs: 1,
		});

		expect(resolution).toBe(unknown);
		expect(attempts).toBe(0);
	});

	it("returns the latest transient error after the reconnect deadline", async () => {
		let attempts = 0;
		const resolution = await waitForModelResolution({
			initial: unavailable,
			resolve: () => {
				attempts++;
				return unavailable;
			},
			timeoutMs: 0,
			pollIntervalMs: 1,
		});

		expect(resolution).toBe(unavailable);
		expect(attempts).toBe(0);
	});
});
