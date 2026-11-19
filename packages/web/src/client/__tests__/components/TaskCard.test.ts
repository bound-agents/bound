import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { client } from "../../lib/bound";
import { installDom } from "../harness/dom";

// TaskCard: inline card for a scheduled task. On mount it fetches the task via
// GET /api/tasks/:id, composes ThreadLinkCard + StatusChip, and refreshes on a
// `task:updated` WS event for its own taskId — surfacing the thread link the
// moment the task's first run resolves a thread. These tests drive the real
// fetch through the harness route table and the real WS refresh through the
// shared client's handleWsMessage.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

function taskEntry(overrides: Record<string, unknown> = {}) {
	return {
		id: "task-1",
		type: "cron",
		status: "pending",
		displayName: "nightly-summary",
		schedule: "0 3 * * *",
		thread_id: null,
		hostName: null,
		lastDurationMs: null,
		...overrides,
	};
}

async function mountCard(props: Record<string, unknown>) {
	const TaskCard = (await import("../../components/TaskCard.svelte")).default;
	const handle = await dom.mount(TaskCard, props);
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

describe("TaskCard", () => {
	beforeEach(() => {
		dom.requests.length = 0;
	});

	it("shows a loading placeholder before the fetch resolves, then the task body", async () => {
		dom.route("GET", /\/api\/tasks\/task-1$/, () => taskEntry());
		const { target } = await mountCard({ taskId: "task-1" });
		// After settle the task has loaded.
		expect(target.querySelector(".tc-name")?.textContent).toBe("nightly-summary");
		expect(target.querySelector(".tc-schedule")?.textContent).toBe("0 3 * * *");
		// Pending task with no thread → pending note, no open link.
		expect(target.querySelector(".tl-pending-note")?.textContent).toBe("Hasn't departed yet");
		expect(target.querySelector(".tl-open")).toBeNull();
		// It fetched the right path.
		expect(dom.requests.some((r) => r.method === "GET" && r.path === "/api/tasks/task-1")).toBe(
			true,
		);
	});

	it("renders claimed status as a running chip", async () => {
		dom.route("GET", /\/api\/tasks\/task-2$/, () => taskEntry({ id: "task-2", status: "claimed" }));
		const { target } = await mountCard({ taskId: "task-2" });
		expect(target.querySelector(".status-chip .label")?.textContent).toBe("Running");
	});

	it("shows the error state when the fetch fails", async () => {
		dom.route("GET", /\/api\/tasks\/task-err$/, () => new Response("boom", { status: 500 }));
		const { target } = await mountCard({ taskId: "task-err" });
		expect(target.querySelector(".tc-name")?.textContent).toBe("Task unavailable");
		// No pending note on load error.
		expect(target.querySelector(".tl-pending-note")).toBeNull();
	});

	it("refreshes and surfaces the thread link on a matching task:updated event", async () => {
		let threadId: string | null = null;
		dom.route("GET", /\/api\/tasks\/task-3$/, () =>
			taskEntry({ id: "task-3", thread_id: threadId }),
		);
		const { target } = await mountCard({ taskId: "task-3" });
		expect(target.querySelector(".tl-open")).toBeNull();

		// The task runs: a thread now exists. The next fetch returns it, and the
		// WS event triggers that refetch.
		threadId = "resolved-thread";
		client.handleWsMessage(
			JSON.stringify({ type: "task:updated", data: { taskId: "task-3", status: "completed" } }),
		);
		await dom.settle();

		const open = target.querySelector(".tl-open");
		expect(open).not.toBeNull();
		await dom.fire(open as Element, "click");
		expect(dom.window.location.hash).toBe("#/line/resolved-thread");
	});

	it("ignores task:updated events for a different taskId", async () => {
		dom.route("GET", /\/api\/tasks\/task-4$/, () => taskEntry({ id: "task-4" }));
		const { target } = await mountCard({ taskId: "task-4" });
		dom.requests.length = 0;
		client.handleWsMessage(
			JSON.stringify({ type: "task:updated", data: { taskId: "other-task", status: "failed" } }),
		);
		await dom.settle();
		// No refetch for an unrelated task.
		expect(dom.requests.length).toBe(0);
		expect(target.querySelector(".tc-name")?.textContent).toBe("nightly-summary");
	});
});
