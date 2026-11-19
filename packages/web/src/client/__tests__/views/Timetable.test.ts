import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

type Task = {
	id: string;
	type: string;
	status: string;
	displayName: string;
	schedule: string | null;
	hostName: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
	lastDurationMs: number | null;
	run_count: number;
	consecutive_failures: number;
	no_history: number;
	thread_id: string | null;
	error: string | null;
};

const task = (over: Partial<Task> = {}): Task => ({
	id: "task-aaaaaaaa",
	type: "cron",
	status: "pending",
	displayName: "nightly sweep",
	schedule: "0 3 * * *",
	hostName: "alpha",
	next_run_at: "2099-01-01T00:00:00.000Z",
	last_run_at: "2026-11-18T00:00:00.000Z",
	lastDurationMs: 1500,
	run_count: 4,
	consecutive_failures: 0,
	no_history: 0,
	thread_id: null,
	error: null,
	...over,
});

// One shared jsdom across the suite: Timetable runs a live setInterval poll,
// and re-installing the dom per test leaves the prior component's reactive
// graph pointing at a closed window, which crashes the next mount with
// "get nextSibling called on an object that is not a valid instance of Node".
// Instead, mount once per test into the shared dom and unmount synchronously
// between tests so onDestroy (clearInterval) runs before the next mount.
let dom: ReturnType<typeof installDom>;
let unmountCurrent: (() => void) | null = null;

beforeAll(() => {
	dom = installDom();
});

afterEach(() => {
	unmountCurrent?.();
	unmountCurrent = null;
});

afterAll(() => {
	dom.teardown();
});

async function mount(tasks: Task[]) {
	dom.route("GET", "/api/tasks", () => tasks);
	const Timetable = (await import("../../views/Timetable.svelte")).default;
	const mounted = await dom.mount(Timetable, {});
	unmountCurrent = mounted.unmount;
	await dom.settle();
	return mounted;
}

describe("Timetable", () => {
	it("loads tasks and renders a row per task", async () => {
		const { target } = await mount([
			task({ id: "task-11111111", displayName: "first" }),
			task({ id: "task-22222222", displayName: "second", type: "heartbeat" }),
		]);
		expect(dom?.requests.some((r) => r.method === "GET" && r.path === "/api/tasks")).toBe(true);
		expect(target.textContent).toContain("first");
		expect(target.textContent).toContain("second");
		// Footer reports total.
		expect(target.textContent).toContain("2 of 2 tasks");
	});

	it("shows the empty state when there are no tasks", async () => {
		const { target } = await mount([]);
		expect(target.textContent).toContain("No scheduled tasks.");
	});

	it("filters tasks by status via the filter chips", async () => {
		const { target } = await mount([
			task({ id: "task-aaaaaaaa", displayName: "pending-one", status: "pending" }),
			task({ id: "task-bbbbbbbb", displayName: "done-one", status: "completed" }),
		]);
		const chips = [...target.querySelectorAll("button.filter-chip")];
		const failedChip = chips.find((c) => c.textContent?.includes("Failed"));
		const pendingChip = chips.find((c) => c.textContent?.includes("Pending"));
		expect(pendingChip).toBeTruthy();
		// Filtering to "failed" hides both rows.
		await dom?.fire(failedChip as Element, "click");
		expect(target.textContent).toContain("0 of 2 tasks");
		// Filtering to "pending" shows only the pending row.
		await dom?.fire(failedChip as Element, "click"); // toggle off
		await dom?.fire(pendingChip as Element, "click");
		expect(target.textContent).toContain("pending-one");
		expect(target.textContent).not.toContain("done-one");
		expect(target.textContent).toContain("1 of 2 tasks");
	});

	it("treats claimed tasks as running for the running filter and counts", async () => {
		const { target } = await mount([
			task({ id: "task-claimed1", displayName: "claimed-task", status: "claimed" }),
		]);
		const chips = [...target.querySelectorAll("button.filter-chip")];
		const runningChip = chips.find((c) => c.textContent?.includes("Running"));
		// The running chip's count includes the claimed task.
		expect(runningChip?.textContent).toMatch(/Running\s*1/);
		await dom?.fire(runningChip as Element, "click");
		expect(target.textContent).toContain("claimed-task");
		expect(target.textContent).toContain("1 of 1 tasks");
	});

	it("expands a row on click and shows details", async () => {
		const { target } = await mount([
			task({ id: "task-detail01", displayName: "expandable", run_count: 9 }),
		]);
		const row = target.querySelector(".task-row") as HTMLElement;
		expect(target.textContent).not.toContain("Task ID");
		await dom?.fire(row, "click");
		expect(target.textContent).toContain("Task ID");
		expect(target.textContent).toContain("task-detail01");
		expect(target.textContent).toContain("9");
		// Clicking again collapses.
		await dom?.fire(row, "click");
		expect(target.textContent).not.toContain("Task ID");
	});

	it("cancels a cancellable task and reloads", async () => {
		let cancelHits = 0;
		dom = installDom();
		dom.route("GET", "/api/tasks", () => [
			task({ id: "task-cancel01", displayName: "running-task", status: "running" }),
		]);
		dom.route("POST", /\/api\/tasks\/task-cancel01\/cancel/, () => {
			cancelHits++;
			return task({ id: "task-cancel01", status: "cancelled" });
		});
		const Timetable = (await import("../../views/Timetable.svelte")).default;
		const { target } = await dom.mount(Timetable, {});
		await dom.settle();
		const cancelBtn = target.querySelector("button.action-btn.cancel") as HTMLElement;
		expect(cancelBtn?.textContent).toContain("Cancel");
		await dom.fire(cancelBtn, "click");
		expect(cancelHits).toBe(1);
		expect(dom.requests.some((r) => r.method === "POST" && r.path.includes("/cancel"))).toBe(true);
	});

	it("renders an error badge for a failed task instead of a cancel button", async () => {
		const { target } = await mount([
			task({
				id: "task-failed01",
				displayName: "broken",
				status: "failed",
				error: "it exploded",
			}),
		]);
		expect(target.querySelector("button.action-btn.cancel")).toBeNull();
		const badge = target.querySelector(".err-badge");
		expect(badge?.textContent).toContain("ERR");
		expect(badge?.getAttribute("title")).toBe("it exploded");
	});

	it("shows the error box in the expanded panel for a failed task", async () => {
		const { target } = await mount([
			task({ id: "task-failed02", status: "failed", error: "stack trace here" }),
		]);
		const row = target.querySelector(".task-row") as HTMLElement;
		await dom?.fire(row, "click");
		expect(target.textContent).toContain("Last Error");
		expect(target.querySelector(".err-box")?.textContent).toContain("stack trace here");
	});

	it("toggles no_history from the expanded panel", async () => {
		let patchBody: unknown = null;
		dom = installDom();
		dom.route("GET", "/api/tasks", () => [task({ id: "task-hist0001", no_history: 0 })]);
		dom.route("PATCH", /\/api\/tasks\/task-hist0001$/, (req) => {
			patchBody = req.body;
			return task({ id: "task-hist0001", no_history: 1 });
		});
		const Timetable = (await import("../../views/Timetable.svelte")).default;
		const { target } = await dom.mount(Timetable, {});
		await dom.settle();
		const row = target.querySelector(".task-row") as HTMLElement;
		await dom.fire(row, "click");
		const toggle = target.querySelector("button.history-toggle") as HTMLElement;
		expect(toggle?.textContent?.trim()).toBe("enabled");
		await dom.fire(toggle, "click");
		expect(patchBody).toEqual({ no_history: true });
		expect(
			dom.requests.some((r) => r.method === "PATCH" && /\/api\/tasks\/task-hist0001$/.test(r.path)),
		).toBe(true);
	});

	it("navigates to the task's thread from the expanded panel", async () => {
		dom = installDom({ url: "http://localhost/#/timetable" });
		dom.route("GET", "/api/tasks", () => [
			task({ id: "task-thread01", thread_id: "thread-xyz123456789" }),
		]);
		const Timetable = (await import("../../views/Timetable.svelte")).default;
		const { target } = await dom.mount(Timetable, {});
		await dom.settle();
		const row = target.querySelector(".task-row") as HTMLElement;
		await dom.fire(row, "click");
		const link = target.querySelector("button.thread-link") as HTMLElement;
		expect(link?.textContent).toContain("thread-xyz");
		await dom.fire(link, "click");
		expect(dom.window.location.hash).toContain("/line/thread-xyz123456789");
	});

	it("expands a row via keyboard (Enter)", async () => {
		const { target } = await mount([task({ id: "task-keyboard1" })]);
		const row = target.querySelector(".task-row") as HTMLElement;
		await dom?.fire(row, "keydown", { key: "Enter" });
		expect(target.textContent).toContain("Task ID");
	});

	it("keeps rendering after a failed load (loading resolves, empty state shown)", async () => {
		dom = installDom();
		dom.route("GET", "/api/tasks", () => new Response("nope", { status: 500 }));
		const Timetable = (await import("../../views/Timetable.svelte")).default;
		const { target } = await dom.mount(Timetable, {});
		await dom.settle();
		// load() swallows the error and clears loading; with no tasks it shows empty.
		expect(target.textContent).not.toContain("Loading schedule…");
		expect(target.textContent).toContain("No scheduled tasks.");
	});
});
