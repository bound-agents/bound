import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { writable } from "svelte/store";
import type { WebSocketMessage } from "../../lib/bound";
import { installDom } from "../harness/dom";

// DebugPanelWrapper: a two-pane shell whose child snippet receives a
// { debugOpen, toggleDebug, turnRange } control bag. The ContextDebugPanel is
// lazily mounted on first open (debugMounted latch) and only when a threadId
// exists; closing it hides the pane (display:none) but keeps it mounted. These
// tests drive toggleDebug through a real-component harness (the control bag is
// a svelte snippet, which createRawSnippet can't wire event handlers into, so a
// tiny .svelte fixture consumes it) and assert the panel-open class, the lazy
// mount gate, the keep-mounted-on-close behavior, and the threadId gate.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountWrapper(props: Record<string, unknown>) {
	const Harness = (await import("./fixtures/DebugPanelWrapperHarness.svelte")).default;
	const wsEvents = writable<WebSocketMessage[]>([]);
	const handle = await dom.mount(Harness, { wsEvents, ...props });
	unmounts.push(handle.unmount);
	return handle;
}

describe("DebugPanelWrapper", () => {
	it("starts closed with no panel mounted", async () => {
		dom.route("GET", /\/context-debug$/, () => []);
		const { target } = await mountWrapper({ threadId: "thread-a" });
		const wrapper = target.querySelector(".debug-wrapper") as HTMLElement;
		expect(wrapper.classList).not.toContain("panel-open");
		expect(target.querySelector(".debug-panel-container")).toBeNull();
		expect(target.querySelector(".dbg-toggle")?.textContent).toBe("closed");
	});

	it("mounts the panel and marks open on first toggle", async () => {
		dom.route("GET", /\/context-debug$/, () => []);
		const { target } = await mountWrapper({ threadId: "thread-a" });
		await dom.fire(target.querySelector(".dbg-toggle") as HTMLButtonElement, "click");
		const wrapper = target.querySelector(".debug-wrapper") as HTMLElement;
		expect(wrapper.classList).toContain("panel-open");
		expect(target.querySelector(".dbg-toggle")?.textContent).toBe("open");
		const container = target.querySelector(".debug-panel-container") as HTMLElement;
		expect(container).not.toBeNull();
		expect(container.classList).not.toContain("hidden");
	});

	it("keeps the panel mounted but hidden after closing", async () => {
		dom.route("GET", /\/context-debug$/, () => []);
		const { target } = await mountWrapper({ threadId: "thread-a" });
		const btn = target.querySelector(".dbg-toggle") as HTMLButtonElement;
		await dom.fire(btn, "click"); // open
		await dom.fire(btn, "click"); // close
		const wrapper = target.querySelector(".debug-wrapper") as HTMLElement;
		expect(wrapper.classList).not.toContain("panel-open");
		// Still mounted (lazy latch stays set), just hidden.
		const container = target.querySelector(".debug-panel-container") as HTMLElement;
		expect(container).not.toBeNull();
		expect(container.classList).toContain("hidden");
	});

	it("never mounts the panel when there is no threadId", async () => {
		const { target } = await mountWrapper({ threadId: null });
		await dom.fire(target.querySelector(".dbg-toggle") as HTMLButtonElement, "click");
		// debugOpen flips (panel-open class) but the panel is gated on threadId.
		expect((target.querySelector(".debug-wrapper") as HTMLElement).classList).toContain(
			"panel-open",
		);
		expect(target.querySelector(".debug-panel-container")).toBeNull();
	});
});
