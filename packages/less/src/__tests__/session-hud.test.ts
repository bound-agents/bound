import { describe, expect, it } from "bun:test";
import type { BoundClient } from "@bound/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { contextGaugeColor } from "../tui/components/StatusBar";
import { formatTokens, formatUsd } from "../tui/components/StatusBar";
import { useSessionHud } from "../tui/hooks/useSessionHud";

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

describe("useSessionHud context gauge", () => {
	it("updates context tokens/window/pct from a context:debug event for this thread", async () => {
		const listeners = new Map<string, Set<EventHandler>>();
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
		} as unknown as BoundClient;

		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness() {
			const hud = useSessionHud(client, "thread-1");
			hudRef = hud;
			return React.createElement(Text, null, `pct:${hud.contextPct ?? "none"}`);
		}

		const { lastFrame } = render(React.createElement(Harness));
		await tick();
		expect(lastFrame()).toContain("pct:none");

		for (const handler of listeners.get("context:debug") ?? []) {
			handler({
				thread_id: "thread-1",
				debug: { contextWindow: 200_000, actualTotalTokens: 50_000 },
			});
		}
		await tick();
		expect(hudRef?.contextTokens).toBe(50_000);
		expect(hudRef?.contextWindow).toBe(200_000);
		expect(hudRef?.contextPct).toBeCloseTo(0.25, 5);
	});

	it("falls back to totalEstimated when actualTotalTokens is absent", async () => {
		const listeners = new Map<string, Set<EventHandler>>();
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
		} as unknown as BoundClient;

		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness() {
			const hud = useSessionHud(client, "thread-1");
			hudRef = hud;
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();

		for (const handler of listeners.get("context:debug") ?? []) {
			handler({
				thread_id: "thread-1",
				debug: { contextWindow: 100_000, totalEstimated: 10_000 },
			});
		}
		await tick();
		expect(hudRef?.contextTokens).toBe(10_000);
		expect(hudRef?.contextPct).toBeCloseTo(0.1, 5);
	});

	it("ignores a context:debug event for a different thread", async () => {
		const listeners = new Map<string, Set<EventHandler>>();
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
		} as unknown as BoundClient;

		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness() {
			const hud = useSessionHud(client, "thread-1");
			hudRef = hud;
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();

		for (const handler of listeners.get("context:debug") ?? []) {
			handler({ thread_id: "other", debug: { contextWindow: 100, actualTotalTokens: 50 } });
		}
		await tick();
		expect(hudRef?.contextPct).toBeNull();
	});
});

describe("useSessionHud cost refresh on turn completion", () => {
	function costClient() {
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
				return Promise.resolve({ cost_usd: 1.5 });
			},
			getThreadCost() {
				return Promise.resolve(0.42);
			},
		} as unknown as BoundClient;
		return { client, listeners, getFetches: () => fetches };
	}

	it("refreshes spend when a turn goes inactive (thread:status active:false)", async () => {
		const { client, listeners, getFetches } = costClient();
		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness() {
			const hud = useSessionHud(client, "thread-1", 0);
			hudRef = hud;
			return React.createElement(Text, null, `cost:${hud.threadCostUsd ?? "none"}`);
		}
		render(React.createElement(Harness));
		await tick();
		const mountFetches = getFetches();

		for (const handler of listeners.get("thread:status") ?? []) {
			handler({ thread_id: "thread-1", active: false });
		}
		await tick();
		expect(getFetches()).toBeGreaterThan(mountFetches);
		expect(hudRef?.threadCostUsd).toBe(0.42);
		expect(hudRef?.todayCostUsd).toBe(1.5);
	});

	it("does not refresh when the turn goes active (active:true)", async () => {
		const { client, listeners, getFetches } = costClient();
		function Harness() {
			useSessionHud(client, "thread-1", 0);
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();
		const before = getFetches();

		for (const handler of listeners.get("thread:status") ?? []) {
			handler({ thread_id: "thread-1", active: true });
		}
		await tick();
		expect(getFetches()).toBe(before);
	});

	it("debounces cost refreshes within the min interval", async () => {
		const { client, listeners, getFetches } = costClient();
		function Harness() {
			// Large interval → the mount fetch (force=true) lands, later events are debounced.
			useSessionHud(client, "thread-1", 1_000_000);
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();
		const afterMount = getFetches();
		expect(afterMount).toBe(1);

		for (const handler of listeners.get("thread:status") ?? []) {
			handler({ thread_id: "thread-1", active: false });
		}
		await tick();
		expect(getFetches()).toBe(afterMount);
	});

	it("degrades silently when the client lacks cost methods", async () => {
		const listeners = new Map<string, Set<EventHandler>>();
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
		} as unknown as BoundClient;

		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness() {
			const hud = useSessionHud(client, "thread-1", 0);
			hudRef = hud;
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();
		// No throw, cost stays null.
		expect(hudRef?.threadCostUsd).toBeNull();
		expect(hudRef?.todayCostUsd).toBeNull();

		// A turn-complete event must still not throw with missing methods.
		for (const handler of listeners.get("thread:status") ?? []) {
			handler({ thread_id: "thread-1", active: false });
		}
		await tick();
		expect(hudRef?.threadCostUsd).toBeNull();
	});

	it("degrades to no HUD when the client has no on/off methods", async () => {
		const client = {
			getBackgroundCount() {
				return 0;
			},
		} as unknown as BoundClient;
		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness() {
			const hud = useSessionHud(client, "thread-1");
			hudRef = hud;
			return React.createElement(Text, null, "ok");
		}
		render(React.createElement(Harness));
		await tick();
		expect(hudRef?.contextPct).toBeNull();
	});
});

describe("useSessionHud thread switching", () => {
	it("blanks thread cost and re-seeds background count when threadId changes", async () => {
		const client = createHudClient({ "thread-1": 3, "thread-2": 7 });
		let hudRef: ReturnType<typeof useSessionHud> | null = null;
		function Harness({ threadId }: { threadId: string }) {
			const hud = useSessionHud(client, threadId);
			hudRef = hud;
			return React.createElement(Text, null, `bg:${hud.backgroundCount}`);
		}
		const { rerender } = render(React.createElement(Harness, { threadId: "thread-1" }));
		await tick();
		expect(hudRef?.backgroundCount).toBe(3);

		rerender(React.createElement(Harness, { threadId: "thread-2" }));
		await tick();
		expect(hudRef?.backgroundCount).toBe(7);
		expect(hudRef?.threadCostUsd).toBeNull();
	});

	it("detaches all event listeners on unmount", async () => {
		const offCalls: string[] = [];
		const client = {
			on() {},
			off(event: string) {
				offCalls.push(event);
			},
			getBackgroundCount() {
				return 0;
			},
		} as unknown as BoundClient;
		function Harness() {
			useSessionHud(client, "thread-1");
			return React.createElement(Text, null, "ok");
		}
		const { unmount } = render(React.createElement(Harness));
		await tick();
		unmount();
		await tick();
		expect(offCalls).toContain("context:debug");
		expect(offCalls).toContain("thread:status");
		expect(offCalls).toContain("background:count");
		expect(offCalls).toContain("yard:execution");
	});
});
