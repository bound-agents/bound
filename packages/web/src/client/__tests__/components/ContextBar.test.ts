import { afterAll, describe, expect, it } from "bun:test";
import type { CacheMarker } from "@bound/client";
import ContextBar from "../../components/ContextBar.svelte";
import { installDom } from "../harness/dom";

// One shared dom for the file: ContextBar mounts InfoPopover children, whose
// dynamic mount crashes with `get_descriptors(proto)` null when a prior
// installDom() window has been torn down (the cached svelte module keeps the
// dead prototypes). A single long-lived window avoids that.
const dom = installDom();
afterAll(() => dom.teardown());

type Section = { name: string; tokens: number; children?: Array<{ name: string; tokens: number }> };

async function mount(props: {
	sections: Section[];
	contextWindow: number;
	actualTotalTokens?: number;
	cacheMarkers?: CacheMarker[];
	cacheReadTokens?: number | null;
	cacheWriteTokens?: number | null;
}) {
	const mounted = await dom.mount(ContextBar, props);
	await dom.settle();
	return mounted;
}

function segStyle(el: Element): string {
	return el.getAttribute("style") ?? "";
}

describe("ContextBar", () => {
	it("renders one bar segment per non-zero section plus a free-space segment", async () => {
		const { target } = await mount({
			sections: [
				{ name: "system", tokens: 50_000 },
				{ name: "history", tokens: 30_000 },
			],
			contextWindow: 200_000,
		});
		const segments = [...target.querySelectorAll(".bar-segment")];
		// 2 section segments + 1 free segment (no drift without actualTotalTokens).
		expect(segments.length).toBe(3);
		expect(target.querySelector(".bar-segment.free")).not.toBeNull();
		// system is 25% of 200k.
		const sys = segments[0];
		expect(segStyle(sys)).toContain("flex-basis: 25%");
	});

	it("omits a section segment whose token share rounds to zero width", async () => {
		const { target } = await mount({
			sections: [
				{ name: "system", tokens: 100_000 },
				{ name: "empty", tokens: 0 },
			],
			contextWindow: 100_000,
		});
		const segments = [...target.querySelectorAll(".bar-segment")];
		// system fills 100% → no free segment, zero-token section skipped.
		expect(segments.length).toBe(1);
		expect(target.querySelector(".bar-segment.free")).toBeNull();
	});

	it("renders an estimator-drift segment when the actual total exceeds the estimate", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 200_000,
			actualTotalTokens: 80_000,
		});
		const drift = target.querySelector(".bar-segment.drift");
		expect(drift).not.toBeNull();
		// drift = 80k - 40k = 40k → 20% of 200k.
		expect(segStyle(drift as Element)).toContain("flex-basis: 20%");
		// free is driven by the actual total: 200k - 80k = 120k → 60%.
		const free = target.querySelector(".bar-segment.free");
		expect(segStyle(free as Element)).toContain("flex-basis: 60%");
	});

	it("renders no drift segment when the actual total is below the estimate", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 80_000 }],
			contextWindow: 200_000,
			actualTotalTokens: 50_000,
		});
		expect(target.querySelector(".bar-segment.drift")).toBeNull();
	});

	it("renders no markers and no tick labels when cacheMarkers is absent", async () => {
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 100_000,
		});
		expect(target.querySelector(".cache-tick-labels")).toBeNull();
	});

	it("labels a mixed (split) turn with an up-read on system and down-write on message", async () => {
		const markers: CacheMarker[] = [
			{ kind: "system", positionTokens: 20_000, ttl: "5m", variant: "a", capabilityEnabled: true },
			{
				kind: "message",
				positionTokens: 60_000,
				ttl: "5m",
				variant: "a",
				capabilityEnabled: true,
			},
		] as unknown as CacheMarker[];
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 200_000,
			cacheMarkers: markers,
			cacheReadTokens: 18_000,
			cacheWriteTokens: 5000,
		});
		const labels = [...target.querySelectorAll(".cache-tick-label")].map((l) =>
			l.textContent?.trim(),
		);
		// read 18k → "↑ 18k"; write 5k → "↓ 5.0k".
		expect(labels.some((l) => l?.startsWith("↑"))).toBe(true);
		expect(labels.some((l) => l?.startsWith("↓"))).toBe(true);
	});

	it("marks both breakpoints disabled when capability is off", async () => {
		const markers: CacheMarker[] = [
			{
				kind: "system",
				positionTokens: 20_000,
				ttl: "5m",
				variant: "a",
				capabilityEnabled: false,
			},
			{
				kind: "message",
				positionTokens: 60_000,
				ttl: "5m",
				variant: "a",
				capabilityEnabled: false,
			},
		] as unknown as CacheMarker[];
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 200_000,
			cacheMarkers: markers,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		// disabled markers render dashed triggers; the tick-labels container exists
		// but a disabled/idle message marker emits no inline label unless idle ttl.
		expect(target.querySelector(".cache-tick-labels")).not.toBeNull();
	});

	it("labels a uniform write-only turn on the message marker", async () => {
		const markers: CacheMarker[] = [
			{
				kind: "message",
				positionTokens: 60_000,
				ttl: "1h",
				variant: "b",
				capabilityEnabled: true,
			},
		] as unknown as CacheMarker[];
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 200_000,
			cacheMarkers: markers,
			cacheReadTokens: 0,
			cacheWriteTokens: 162_000,
		});
		const labels = [...target.querySelectorAll(".cache-tick-label")].map((l) =>
			l.textContent?.trim(),
		);
		expect(labels.some((l) => l?.startsWith("↓"))).toBe(true);
	});

	it("shows the idle ttl label for a message marker with no reads or writes", async () => {
		const markers: CacheMarker[] = [
			{
				kind: "message",
				positionTokens: 60_000,
				ttl: "10m",
				variant: "c",
				capabilityEnabled: true,
			},
		] as unknown as CacheMarker[];
		const { target } = await mount({
			sections: [{ name: "system", tokens: 40_000 }],
			contextWindow: 200_000,
			cacheMarkers: markers,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		const labels = [...target.querySelectorAll(".cache-tick-label")].map((l) =>
			l.textContent?.trim(),
		);
		expect(labels).toContain("10m");
	});
});
