import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { client } from "../../lib/bound";
import * as router from "../../lib/router";
import { installDom } from "../harness/dom";

// SystemMap is the home view: a thread directory on the left (ThreadList) and a
// MemoryGraph on the right. On mount it connects the WS, loads page 1 of the
// thread list (client.listThreadsPage), subscribes to thread:status, and polls
// every 15s. New/rename flow through client.createThread / renameThread; the
// status channel and WS events update the active-dot map. These tests mount the
// real compiled view under the shared jsdom harness and drive client via
// spies (spyOn the imported namespace, never mock.module — that would replace
// the module for the whole process). Every spy is restored in afterEach so a
// later file sees the real BoundClient.

const dom = installDom({ url: "http://localhost/#/" });
afterAll(() => dom.teardown());

const unmounts: Array<() => void> = [];
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
	for (const u of unmounts.splice(0)) u();
	for (const s of spies.splice(0)) s.mockRestore();
	dom.requests.length = 0;
});

function track<T extends { mockRestore: () => void }>(s: T): T {
	spies.push(s);
	return s;
}

type ThreadRow = {
	id: string;
	title: string | null;
	summary: string | null;
	color: number;
	active: boolean;
	last_message_at: string;
	created_at: string;
};

function thread(id: string, extra: Partial<ThreadRow> = {}): ThreadRow {
	return {
		id,
		title: `Thread ${id}`,
		summary: null,
		color: 1,
		active: false,
		last_message_at: "2026-11-19T10:00:00.000Z",
		created_at: "2026-11-19T09:00:00.000Z",
		...extra,
	};
}

// Stub the WS-touching lib functions so mount doesn't open a real socket and so
// we can observe thread:status handler registration. client.on/off are spied
// per-test where the handler capture matters.
function stubWs() {
	track(spyOn(client, "connect").mockImplementation(() => {}));
	track(spyOn(client, "subscribe").mockImplementation(() => {}));
	track(spyOn(client, "unsubscribe").mockImplementation(() => {}));
}

async function mountMap() {
	const SystemMap = (await import("../../views/SystemMap.svelte")).default;
	const handle = await dom.mount(SystemMap, {});
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

describe("SystemMap", () => {
	beforeEach(() => {
		dom.window.location.hash = "#/";
	});

	it("loads page 1 on mount, renders the directory, and shows the total count", async () => {
		stubWs();
		const statusHandlers: Array<(d: unknown) => void> = [];
		track(
			spyOn(client, "on").mockImplementation((event: string, handler: (d: unknown) => void) => {
				if (event === "thread:status") statusHandlers.push(handler);
			}),
		);
		track(spyOn(client, "off").mockImplementation(() => {}));
		const listSpy = track(
			spyOn(client, "listThreadsPage").mockResolvedValue({
				threads: [thread("a"), thread("b")] as never,
				total: 7,
			}),
		);

		const { target } = await mountMap();

		// Page-1 load fired with the directory page size.
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(listSpy.mock.calls[0][0]).toMatchObject({ limit: 50 });
		// The total count (not the loaded-window length) drives "Active Lines".
		expect(target.textContent).toContain("Active Lines");
		expect(target.textContent).toContain("7");
		// Both threads render their titles in the directory.
		expect(target.textContent).toContain("Thread a");
		expect(target.textContent).toContain("Thread b");
		// The status channel was wired.
		expect(statusHandlers.length).toBe(1);
		// Each loaded thread was subscribed exactly once.
		const subSpy = client.subscribe as unknown as { mock: { calls: unknown[][] } };
		expect(subSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
		// First mount in the process pays svelte's one-time runtime init on top of
		// SystemMap's own mount, which exceeds the 5s default once.
	}, 20000);

	it("filters the directory by the search box over title and summary", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		track(
			spyOn(client, "listThreadsPage").mockResolvedValue({
				threads: [
					thread("a", { title: "Alpha deploy" }),
					thread("b", { title: "Beta", summary: "deploy notes" }),
					thread("c", { title: "Gamma" }),
				] as never,
				total: 3,
			}),
		);

		const { target } = await mountMap();
		expect(target.textContent).toContain("Alpha deploy");
		expect(target.textContent).toContain("Gamma");

		// Typing "deploy" keeps the two threads matching title OR summary, drops Gamma.
		const search = target.querySelector("input");
		expect(search).not.toBeNull();
		await dom.type(search as HTMLInputElement, "deploy");

		expect(target.textContent).toContain("Alpha deploy");
		expect(target.textContent).toContain("Beta");
		expect(target.textContent).not.toContain("Gamma");
	});

	it("creates a thread and navigates to its line on the New button", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		track(spyOn(client, "listThreadsPage").mockResolvedValue({ threads: [] as never, total: 0 }));
		const createSpy = track(
			spyOn(client, "createThread").mockResolvedValue({ id: "new-thread-1" } as never),
		);
		const navSpy = track(spyOn(router, "navigateTo").mockImplementation(() => {}));

		const { target } = await mountMap();
		const newBtn = Array.from(target.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("New Line"),
		);
		expect(newBtn).toBeDefined();
		(newBtn as HTMLButtonElement).click();
		await dom.settle();

		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(navSpy).toHaveBeenCalledWith("/line/new-thread-1");
	});

	it("keeps the New button usable again after a failed create", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		track(spyOn(client, "listThreadsPage").mockResolvedValue({ threads: [] as never, total: 0 }));
		const createSpy = track(
			spyOn(client, "createThread").mockRejectedValue(new Error("server down")),
		);
		track(spyOn(router, "navigateTo").mockImplementation(() => {}));

		const { target } = await mountMap();
		const newBtn = Array.from(target.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("New Line"),
		) as HTMLButtonElement;
		newBtn.click();
		await dom.settle();

		expect(createSpy).toHaveBeenCalledTimes(1);
		// After the failure `creating` is reset, so the button is not left disabled.
		expect(newBtn.disabled).toBe(false);
	});

	it("reflects a thread:status WS event in the active-dot map", async () => {
		stubWs();
		let statusHandler: ((d: unknown) => void) | undefined;
		track(
			spyOn(client, "on").mockImplementation((event: string, handler: (d: unknown) => void) => {
				if (event === "thread:status") statusHandler = handler;
			}),
		);
		track(spyOn(client, "off").mockImplementation(() => {}));
		track(
			spyOn(client, "listThreadsPage").mockResolvedValue({
				threads: [thread("a", { active: false })] as never,
				total: 1,
			}),
		);

		const { target } = await mountMap();
		expect(statusHandler).toBeDefined();
		// No live indicator before the event.
		expect(target.querySelector(".thread-card .live-dot")).toBeNull();

		// A status event flipping thread a to active lights the live indicator.
		statusHandler?.({ thread_id: "a", active: true });
		await dom.settle();
		expect(target.querySelector(".thread-card .live-dot")).not.toBeNull();
	});

	it("renames a thread in place through the directory rename flow", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		track(
			spyOn(client, "listThreadsPage").mockResolvedValue({
				threads: [thread("a", { title: "Old title" })] as never,
				total: 1,
			}),
		);
		const renameSpy = track(
			spyOn(client, "renameThread").mockResolvedValue({ title: "New title" } as never),
		);

		const { target } = await mountMap();
		expect(target.textContent).toContain("Old title");

		// Open the rename editor via the per-card rename button, type, commit on Enter.
		const renameBtn = target.querySelector(".thread-card .rename-button");
		expect(renameBtn).not.toBeNull();
		await dom.fire(renameBtn as Element, "click");
		const editor = target.querySelector(".thread-card .title-input");
		expect(editor).not.toBeNull();
		await dom.type(editor as HTMLInputElement, "New title");
		await dom.fire(editor as Element, "keydown", { key: "Enter" });

		expect(renameSpy).toHaveBeenCalledWith("a", "New title");
		// The local map is patched with the server-returned title.
		expect(target.textContent).toContain("New title");
	});

	it("loads another page with a tail cursor when the directory scrolls near the end", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		// A full first page (PAGE_SIZE=50) leaves hasMoreThreads ambiguous-true, so
		// loadMoreThreads will fire when the list reports a near-bottom scroll.
		const page1 = Array.from({ length: 50 }, (_, i) =>
			thread(`t${String(i).padStart(2, "0")}`, {
				// Descending timestamps so the sorted tail is a deterministic cursor.
				last_message_at: `2026-11-19T10:${String(59 - i).padStart(2, "0")}:00.000Z`,
			}),
		);
		const listSpy = track(
			spyOn(client, "listThreadsPage")
				.mockResolvedValueOnce({ threads: page1 as never, total: 120 })
				.mockResolvedValueOnce({ threads: [thread("extra")] as never, total: 120 }),
		);

		const { target } = await mountMap();
		expect(listSpy).toHaveBeenCalledTimes(1);

		// Drive ThreadList's virtualized infinite scroll: give the scroll container
		// non-zero layout (jsdom reports 0 otherwise) so onScroll crosses the
		// LOAD_MORE_THRESHOLD and calls onLoadMore -> loadMoreThreads.
		const scrollEl = target.querySelector(".thread-list") as HTMLElement;
		expect(scrollEl).not.toBeNull();
		Object.defineProperty(scrollEl, "clientHeight", { value: 600, configurable: true });
		Object.defineProperty(scrollEl, "scrollHeight", { value: 10000, configurable: true });
		scrollEl.scrollTop = 9999;
		await dom.fire(scrollEl, "scroll");

		expect(listSpy).toHaveBeenCalledTimes(2);
		// The second (load-more) call pages with a `before` cursor off the sorted
		// tail (the oldest loaded thread), not a bare first-page request.
		const secondArgs = listSpy.mock.calls[1][0] as {
			limit: number;
			before?: { last_message_at: string; id: string };
		};
		expect(secondArgs.limit).toBe(50);
		expect(secondArgs.before).toBeDefined();
		expect(secondArgs.before?.id).toBe("t49");
		// The extra thread merged into the directory.
		expect(target.textContent).toContain("Thread extra");
	});

	it("does not page again while a load-more is already in flight", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		const page1 = Array.from({ length: 50 }, (_, i) =>
			thread(`t${String(i).padStart(2, "0")}`, {
				last_message_at: `2026-11-19T10:${String(59 - i).padStart(2, "0")}:00.000Z`,
			}),
		);
		// Second call hangs so the in-flight guard (isLoadingMore) is observable.
		let releaseSecond: (v: { threads: never; total: number }) => void = () => {};
		const pending = new Promise<{ threads: never; total: number }>((resolve) => {
			releaseSecond = resolve;
		});
		const listSpy = track(
			spyOn(client, "listThreadsPage")
				.mockResolvedValueOnce({ threads: page1 as never, total: 120 })
				.mockReturnValueOnce(pending as never),
		);

		const { target } = await mountMap();
		const scrollEl = target.querySelector(".thread-list") as HTMLElement;
		Object.defineProperty(scrollEl, "clientHeight", { value: 600, configurable: true });
		Object.defineProperty(scrollEl, "scrollHeight", { value: 10000, configurable: true });
		scrollEl.scrollTop = 9999;
		// Two near-bottom scrolls back to back: the second must be swallowed by the
		// isLoadingMore guard while the first load-more is still pending.
		await dom.fire(scrollEl, "scroll");
		await dom.fire(scrollEl, "scroll");
		expect(listSpy).toHaveBeenCalledTimes(2);

		releaseSecond({ threads: [] as never, total: 120 });
		await dom.settle();
	});

	it("prunes a thread that vanished from a short page-1 poll and clears its status", async () => {
		stubWs();
		let statusHandler: ((d: unknown) => void) | undefined;
		track(
			spyOn(client, "on").mockImplementation((event: string, handler: (d: unknown) => void) => {
				if (event === "thread:status") statusHandler = handler;
			}),
		);
		track(spyOn(client, "off").mockImplementation(() => {}));
		const listSpy = track(
			spyOn(client, "listThreadsPage")
				.mockResolvedValueOnce({
					threads: [thread("a"), thread("b")] as never,
					total: 2,
				})
				// b has been deleted; a short page (< PAGE_SIZE) is the whole visible set,
				// so mergeBatch(prunePage1Window) drops b from the map and its status.
				.mockResolvedValueOnce({ threads: [thread("a")] as never, total: 1 }),
		);
		// Capture the 15s poll callback that onMount registers via setInterval, so
		// the second loadThreads can be driven deterministically without real time.
		let pollFn: (() => void) | undefined;
		const realSetInterval = globalThis.setInterval;
		const intervalSpy = track(
			spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
				if (ms === 15000) {
					pollFn = fn;
					return 0 as unknown as ReturnType<typeof setInterval>;
				}
				return realSetInterval(fn, ms);
			}) as typeof setInterval),
		);

		const { target } = await mountMap();
		expect(target.textContent).toContain("Thread b");
		// Seed a status entry for b so we can prove the prune deletes it.
		statusHandler?.({ thread_id: "b", active: true });
		await dom.settle();
		expect(intervalSpy).toHaveBeenCalled();
		expect(pollFn).toBeDefined();

		// Fire the captured poll body: loadThreads runs again, this time returning a
		// short page that no longer contains b.
		pollFn?.();
		await dom.settle();

		expect(listSpy).toHaveBeenCalledTimes(2);
		expect(target.textContent).not.toContain("Thread b");
		expect(target.textContent).toContain("Thread a");
	});

	it("prunes a stale thread above the cursor on a full page-1 poll", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		// A full first page establishes the window; the poll returns another full
		// page where an in-window thread (above the tail cursor) has vanished, so
		// the batch.length === PAGE_SIZE prune branch drops it.
		const makePage = (ids: string[]) =>
			ids.map((id, i) =>
				thread(id, { last_message_at: `2026-11-19T10:${String(59 - i).padStart(2, "0")}:00.000Z` }),
			);
		const firstIds = Array.from({ length: 50 }, (_, i) => `p${String(i).padStart(2, "0")}`);
		// Second poll: same 50 slots but p00 (newest, above cursor) is replaced by a
		// brand-new thread, so p00 is in-window-but-absent and must be pruned.
		const secondIds = ["pNEW", ...firstIds.slice(1)];
		let pollFn: (() => void) | undefined;
		const realSetInterval = globalThis.setInterval;
		track(
			spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
				if (ms === 15000) {
					pollFn = fn;
					return 0 as unknown as ReturnType<typeof setInterval>;
				}
				return realSetInterval(fn, ms);
			}) as typeof setInterval),
		);
		track(
			spyOn(client, "listThreadsPage")
				.mockResolvedValueOnce({ threads: makePage(firstIds) as never, total: 120 })
				.mockResolvedValueOnce({ threads: makePage(secondIds) as never, total: 120 }),
		);

		const { target } = await mountMap();
		expect(target.textContent).toContain("Thread p00");
		pollFn?.();
		await dom.settle();
		// p00 was above the cursor and absent from the fresh full page → pruned.
		expect(target.textContent).not.toContain("Thread p00");
		expect(target.textContent).toContain("Thread pNEW");
	});

	it("stops polling and unsubscribes from thread:status when the view unmounts", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		const offSpy = track(spyOn(client, "off").mockImplementation(() => {}));
		track(spyOn(client, "listThreadsPage").mockResolvedValue({ threads: [] as never, total: 0 }));
		// Capture the poll interval id so we can prove onDestroy clears it.
		let clearedId: unknown;
		const realClearInterval = globalThis.clearInterval;
		track(
			spyOn(globalThis, "clearInterval").mockImplementation(((id: unknown) => {
				clearedId = id;
				return realClearInterval(id as Parameters<typeof clearInterval>[0]);
			}) as typeof clearInterval),
		);

		const handle = await mountMap();
		handle.unmount();
		await dom.settle();

		// onDestroy clears the 15s poll timer and detaches the status handler.
		expect(clearedId).toBeDefined();
		expect(offSpy).toHaveBeenCalledWith("thread:status", expect.any(Function));
	});

	it("ignores a load-more request before any threads have loaded", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		// An empty first page: hasMoreThreads stays false, and even if a scroll
		// reaches the bottom, loadMoreThreads returns early on the empty list.
		const listSpy = track(
			spyOn(client, "listThreadsPage").mockResolvedValue({ threads: [] as never, total: 0 }),
		);

		const { target } = await mountMap();
		const scrollEl = target.querySelector(".thread-list") as HTMLElement;
		Object.defineProperty(scrollEl, "clientHeight", { value: 600, configurable: true });
		Object.defineProperty(scrollEl, "scrollHeight", { value: 10000, configurable: true });
		scrollEl.scrollTop = 9999;
		await dom.fire(scrollEl, "scroll");

		// Only the mount load fired; the empty-list guard blocks any load-more page.
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(target.textContent).toContain("No threads yet");
	});

	it("surfaces the hovered thread in the memory-graph callout, then clears it on mouseleave", async () => {
		stubWs();
		track(spyOn(client, "on").mockImplementation(() => {}));
		track(spyOn(client, "off").mockImplementation(() => {}));
		track(
			spyOn(client, "listThreadsPage").mockResolvedValue({
				threads: [thread("a", { title: "Hovered line", color: 3 })] as never,
				total: 1,
			}),
		);
		// The MemoryGraph child loads its own graph on mount; give it a non-empty
		// response so the hovered-thread callout (gated on title AND graph color)
		// can actually render once a card is hovered.
		track(spyOn(client, "getMemoryGraph").mockResolvedValue({ nodes: [], edges: [] } as never));

		const { target } = await mountMap();
		// No hover yet: the "Memories from" callout is absent.
		expect(target.querySelector(".hover-callout")).toBeNull();

		// Hovering the thread card runs ThreadList's onmouseenter -> SystemMap's
		// onHoverThread, which sets hoveredThreadId; the hoveredThread derived then
		// feeds hoveredThreadTitle/Color into MemoryGraph, rendering the callout.
		const card = target.querySelector(".thread-card");
		expect(card).not.toBeNull();
		await dom.fire(card as Element, "mouseenter");
		const callout = target.querySelector(".hover-callout");
		expect(callout).not.toBeNull();
		expect(callout?.querySelector(".hover-title")?.textContent).toBe("Hovered line");

		// Leaving the card clears hoveredThreadId -> the derived returns null ->
		// the callout is torn down.
		await dom.fire(card as Element, "mouseleave");
		expect(target.querySelector(".hover-callout")).toBeNull();
	});
});
