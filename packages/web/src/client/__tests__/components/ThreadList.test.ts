import { afterAll, describe, expect, it } from "bun:test";
import type { ThreadListEntry } from "@bound/client";
import ThreadList from "../../components/ThreadList.svelte";
import { installDom } from "../harness/dom";

const dom = installDom();
afterAll(() => dom.teardown());

const now = new Date();
const todayIso = now.toISOString();
const olderIso = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
	return {
		id: "thread-00000001",
		user_id: "u1",
		interface: "web",
		host_origin: "host-a",
		color: 3,
		title: "My Thread",
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: todayIso,
		last_message_at: todayIso,
		modified_at: todayIso,
		deleted: 0,
		model_hint: null,
		agent_id: null,
		parent_thread_id: null,
		messageCount: 12,
		lastModel: "opus-4.8",
		attachedSessionHosts: [],
		active: false,
		...overrides,
	} as ThreadListEntry;
}

const emptyStatuses = new Map<string, { active: boolean }>();

describe("ThreadList", () => {
	it("renders the empty state when there are no threads", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [],
			threadStatuses: emptyStatuses,
		});
		expect(target.querySelector(".empty-state")).not.toBeNull();
		expect(target.textContent).toContain("No threads yet");
		expect(target.querySelector(".thread-card")).toBeNull();
	});

	it("renders a thread card with id slice, line name, title and message count", async () => {
		const thread = makeThread({ id: "abcdef0123456789", title: "Hello World" });
		const { target } = await dom.mount(ThreadList, {
			threads: [thread],
			threadStatuses: emptyStatuses,
		});
		const card = target.querySelector(".thread-card");
		expect(card).not.toBeNull();
		expect(target.querySelector(".thread-id")?.textContent?.trim()).toBe("abcdef01");
		// color 3 -> Tozai
		expect(target.querySelector(".line-name")?.textContent?.trim()).toBe("Tozai");
		expect(target.querySelector(".title")?.textContent?.trim()).toBe("Hello World");
		expect(target.querySelector(".meta")?.textContent).toContain("12 messages");
		expect(target.querySelector(".model")?.textContent?.trim()).toBe("opus-4.8");
	});

	it("groups threads into Today and Earlier headers", async () => {
		const threads = [
			makeThread({ id: "today-0001", last_message_at: todayIso }),
			makeThread({ id: "older-0001", last_message_at: olderIso }),
		];
		const { target } = await dom.mount(ThreadList, {
			threads,
			threadStatuses: emptyStatuses,
		});
		const kickers = [...target.querySelectorAll(".kicker")].map((k) => k.textContent?.trim());
		expect(kickers).toContain("Today");
		expect(kickers).toContain("Earlier");
	});

	it("renders a summary paragraph only when a summary exists", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ summary: "A concise recap." })],
			threadStatuses: emptyStatuses,
		});
		expect(target.querySelector(".summary")?.textContent?.trim()).toBe("A concise recap.");
	});

	it("sanitizes markdown and tool-call noise out of the displayed title", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ title: "**Bold** [link](http://x) `code`" })],
			threadStatuses: emptyStatuses,
		});
		expect(target.querySelector(".title")?.textContent?.trim()).toBe("Bold link code");
	});

	it("falls back to Untitled for an empty title", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ title: "" })],
			threadStatuses: emptyStatuses,
		});
		expect(target.querySelector(".title")?.textContent?.trim()).toBe("Untitled");
	});

	it("shows the Live indicator when the thread status is active", async () => {
		const thread = makeThread({ id: "live-0001" });
		const statuses = new Map([["live-0001", { active: true }]]);
		const { target } = await dom.mount(ThreadList, {
			threads: [thread],
			threadStatuses: statuses,
		});
		expect(target.querySelector(".live")?.textContent).toContain("Live");
	});

	it("does not show the Live indicator when inactive", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "idle-0001" })],
			threadStatuses: new Map([["idle-0001", { active: false }]]),
		});
		expect(target.querySelector(".live")).toBeNull();
	});

	it("renders an attached-session badge with a +N label for multiple hosts", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ attachedSessionHosts: ["mac-mini", "msi", "cloud"] })],
			threadStatuses: emptyStatuses,
		});
		const badge = target.querySelector(".session-badge");
		expect(badge).not.toBeNull();
		expect(target.querySelector(".session-host")?.textContent?.trim()).toBe("mac-mini +2");
		expect(badge?.getAttribute("title")).toContain("Attached sessions on mac-mini, msi, cloud");
	});

	it("renders a single host label without a +N suffix", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ attachedSessionHosts: ["solo-host"] })],
			threadStatuses: emptyStatuses,
		});
		expect(target.querySelector(".session-host")?.textContent?.trim()).toBe("solo-host");
		expect(target.querySelector(".session-badge")?.getAttribute("title")).toContain(
			"Attached session on solo-host",
		);
	});

	it("calls onSelectThread and onNavigateThread on a plain card click", async () => {
		const selected: string[] = [];
		const navigated: string[] = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "click-0001" })],
			threadStatuses: emptyStatuses,
			onSelectThread: (id: string) => selected.push(id),
			onNavigateThread: (id: string) => navigated.push(id),
		});
		await dom.fire(target.querySelector(".thread-card") as Element, "click");
		expect(selected).toEqual(["click-0001"]);
		expect(navigated).toEqual(["click-0001"]);
	});

	it("does not select/navigate when the card is ctrl/meta-clicked", async () => {
		const selected: string[] = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "meta-0001" })],
			threadStatuses: emptyStatuses,
			onSelectThread: (id: string) => selected.push(id),
		});
		await dom.fire(target.querySelector(".thread-card") as Element, "click", { metaKey: true });
		expect(selected).toEqual([]);
	});

	it("fires onHoverThread on enter and null on leave", async () => {
		const hovers: (string | null)[] = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "hover-0001" })],
			threadStatuses: emptyStatuses,
			onHoverThread: (id: string | null) => hovers.push(id),
		});
		const card = target.querySelector(".thread-card") as Element;
		await dom.fire(card, "mouseenter");
		await dom.fire(card, "mouseleave");
		expect(hovers).toEqual(["hover-0001", null]);
	});

	it("enters edit mode and commits a renamed title", async () => {
		const renames: Array<[string, string]> = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "edit-0001", title: "Old Title" })],
			threadStatuses: emptyStatuses,
			onRenameThread: async (id: string, title: string) => {
				renames.push([id, title]);
			},
		});
		const renameBtn = target.querySelector(".rename-button") as Element;
		await dom.fire(renameBtn, "click");
		const input = target.querySelector(".title-input") as HTMLInputElement;
		expect(input).not.toBeNull();
		await dom.type(input, "Brand New Title");
		await dom.fire(input, "keydown", { key: "Enter" });
		expect(renames).toEqual([["edit-0001", "Brand New Title"]]);
		// Edit mode exits after commit.
		expect(target.querySelector(".title-input")).toBeNull();
	});

	it("cancels editing on Escape without calling onRenameThread", async () => {
		const renames: Array<[string, string]> = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "esc-0001", title: "Keep Me" })],
			threadStatuses: emptyStatuses,
			onRenameThread: async (id: string, title: string) => {
				renames.push([id, title]);
			},
		});
		await dom.fire(target.querySelector(".rename-button") as Element, "click");
		const input = target.querySelector(".title-input") as HTMLInputElement;
		await dom.type(input, "Discarded");
		await dom.fire(input, "keydown", { key: "Escape" });
		expect(renames).toEqual([]);
		expect(target.querySelector(".title-input")).toBeNull();
		expect(target.querySelector(".title")?.textContent?.trim()).toBe("Keep Me");
	});

	it("does not rename when the title is unchanged", async () => {
		const renames: Array<[string, string]> = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "same-0001", title: "Same" })],
			threadStatuses: emptyStatuses,
			onRenameThread: async (id: string, title: string) => {
				renames.push([id, title]);
			},
		});
		await dom.fire(target.querySelector(".rename-button") as Element, "click");
		const input = target.querySelector(".title-input") as HTMLInputElement;
		// commit with the same value (blur triggers commitEditing)
		await dom.type(input, "Same");
		await dom.fire(input, "blur");
		expect(renames).toEqual([]);
	});

	it("marks the selected thread card", async () => {
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "sel-0001" })],
			threadStatuses: emptyStatuses,
			selectedThreadId: "sel-0001",
		});
		expect(target.querySelector(".thread-card")?.classList.contains("selected")).toBe(true);
	});

	it("fires onLoadMore when scrolled near the bottom with hasMore", async () => {
		const loadMores: number[] = [];
		// Enough threads that the virtual content is taller than the viewport.
		const threads = Array.from({ length: 40 }, (_, i) =>
			makeThread({ id: `scroll-${String(i).padStart(4, "0")}` }),
		);
		const { target } = await dom.mount(ThreadList, {
			threads,
			threadStatuses: emptyStatuses,
			hasMore: true,
			isLoadingMore: false,
			onLoadMore: () => loadMores.push(1),
		});
		const scroller = target.querySelector<HTMLElement>(".thread-list");
		expect(scroller).not.toBeNull();
		// Jump near the bottom of the virtual content so the load-more threshold trips.
		const totalHeight = Number(
			(target.querySelector<HTMLElement>(".virtual-spacer")?.style.height ?? "0px").replace(
				"px",
				"",
			),
		);
		Object.defineProperty(scroller as HTMLElement, "scrollTop", {
			configurable: true,
			value: totalHeight,
		});
		await dom.fire(scroller as Element, "scroll");
		expect(loadMores.length).toBeGreaterThanOrEqual(1);
	});

	it("does not fire onLoadMore while already loading more", async () => {
		const loadMores: number[] = [];
		const threads = Array.from({ length: 40 }, (_, i) =>
			makeThread({ id: `busy-${String(i).padStart(4, "0")}` }),
		);
		const { target } = await dom.mount(ThreadList, {
			threads,
			threadStatuses: emptyStatuses,
			hasMore: true,
			isLoadingMore: true,
			onLoadMore: () => loadMores.push(1),
		});
		const scroller = target.querySelector<HTMLElement>(".thread-list");
		Object.defineProperty(scroller as HTMLElement, "scrollTop", {
			configurable: true,
			value: 100000,
		});
		await dom.fire(scroller as Element, "scroll");
		expect(loadMores).toEqual([]);
	});

	it("swallows clicks on the title input without selecting the thread", async () => {
		const selected: string[] = [];
		const { target } = await dom.mount(ThreadList, {
			threads: [makeThread({ id: "input-0001", title: "Edit Me" })],
			threadStatuses: emptyStatuses,
			onSelectThread: (id: string) => selected.push(id),
			onRenameThread: async () => {},
		});
		await dom.fire(target.querySelector(".rename-button") as Element, "click");
		const input = target.querySelector(".title-input") as HTMLInputElement;
		await dom.fire(input, "click");
		// The input's onclick stops propagation, so the card select never fires.
		expect(selected).toEqual([]);
		expect(target.querySelector(".title-input")).not.toBeNull();
	});
});
