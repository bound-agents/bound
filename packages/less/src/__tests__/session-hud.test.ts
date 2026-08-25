import { describe, expect, it } from "bun:test";
import type { BoundClient } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { contextGaugeColor } from "../tui/components/StatusBar";
import { formatTokens, formatUsd, useSessionHud } from "../tui/hooks/useSessionHud";

describe("session HUD formatters", () => {
	it("formatUsd: cents precision under $100, whole dollars to $999, k above", () => {
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(0.42)).toBe("$0.42");
		expect(formatUsd(12.345)).toBe("$12.35");
		expect(formatUsd(123.4)).toBe("$123");
		expect(formatUsd(1234)).toBe("$1.2k");
	});

	it("formatTokens: raw to 999, one decimal to 9.9k, whole k to 999k, M above", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(87_000)).toBe("87k");
		expect(formatTokens(1_100_000)).toBe("1.1M");
	});

	it("contextGaugeColor: green under 60%, yellow to 85%, red above", () => {
		expect(contextGaugeColor(0.2)).toBe("green");
		expect(contextGaugeColor(0.59)).toBe("green");
		expect(contextGaugeColor(0.6)).toBe("yellow");
		expect(contextGaugeColor(0.84)).toBe("yellow");
		expect(contextGaugeColor(0.85)).toBe("red");
		expect(contextGaugeColor(1)).toBe("red");
	});
});

type EventHandler = (...args: unknown[]) => void;

function createHudClient(initialCounts: Record<string, number> = {}) {
	const listeners = new Map<string, Set<EventHandler>>();
	const counts = new Map(Object.entries(initialCounts));
	return {
		on(event: string, handler: EventHandler) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
		},
		off(event: string, handler: EventHandler) {
			listeners.get(event)?.delete(handler);
		},
		emitBackground(threadId: string, count: number) {
			counts.set(threadId, count);
			for (const handler of listeners.get("background:count") ?? []) {
				handler({ thread_id: threadId, count });
			}
		},
		getBackgroundCount(threadId: string) {
			return counts.get(threadId) ?? 0;
		},
	} as unknown as BoundClient & {
		emitBackground(threadId: string, count: number): void;
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("useSessionHud background lifecycle", () => {
	it("hydrates a count that arrived before the hook mounted", () => {
		const client = createHudClient({ "thread-1": 2 });

		function Harness() {
			const hud = useSessionHud(client, "thread-1");
			return React.createElement(Text, null, String(hud.backgroundCount));
		}

		const { lastFrame } = render(React.createElement(Harness));
		expect(lastFrame()).toContain("2");
	});

	it("toggles on and off from current-thread events and ignores other threads", async () => {
		const client = createHudClient();

		function Harness() {
			const hud = useSessionHud(client, "thread-1");
			return React.createElement(Text, null, String(hud.backgroundCount));
		}

		const { lastFrame } = render(React.createElement(Harness));
		await tick();
		client.emitBackground("thread-2", 9);
		await tick();
		expect(lastFrame()).toContain("0");

		client.emitBackground("thread-1", 1);
		await tick();
		expect(lastFrame()).toContain("1");

		client.emitBackground("thread-1", 0);
		await tick();
		expect(lastFrame()).toContain("0");
	});
});

describe("useSessionHud cost refresh during Yard runs", () => {
	// A Yard run spends for minutes (aux loops, relayed inference) before its
	// thread ever goes inactive — waiting for thread:status froze the session
	// cost for the whole run (thread 2b372dca). Lifecycle events now trigger
	// the debounced refresh.
	it("refreshes spend on yard:execution events for the current thread", async () => {
		const listeners = new Map<string, Set<EventHandler>>();
		let fetches = 0;
		const client = {
			on(event: string, handler: EventHandler) {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)?.add(handler);
			},
			off(event: string, handler: EventHandler) {
				listeners.get(event)?.delete(handler);
			},
			getBackgroundCount() {
				return 0;
			},
			getMetricsTotals() {
				fetches++;
				return Promise.resolve({ cost_usd: fetches * 0.5 });
			},
			getThreadCost() {
				return Promise.resolve(0.25);
			},
		} as unknown as BoundClient;

		function Harness() {
			const hud = useSessionHud(client, "thread-1", 0);
			return React.createElement(Text, null, `cost:${hud.threadCostUsd ?? "none"}`);
		}

		const { lastFrame } = render(React.createElement(Harness));
		await tick();
		const mountFetches = fetches;
		expect(mountFetches).toBeGreaterThan(0);

		// Mid-run lifecycle event for THIS thread refreshes spend…
		for (const handler of listeners.get("yard:execution") ?? []) {
			handler({ thread_id: "thread-1" });
		}
		await tick();
		expect(fetches).toBeGreaterThan(mountFetches);
		expect(lastFrame()).toContain("cost:");

		// …while another thread's events do not.
		const before = fetches;
		for (const handler of listeners.get("yard:execution") ?? []) {
			handler({ thread_id: "other-thread" });
		}
		await tick();
		expect(fetches).toBe(before);
	});
});
