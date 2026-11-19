import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// DepartureBoard renders scheduled tasks as a train departure board: ranked
// active/upcoming rows (via rankDepartures), a type→line badge, a countdown
// (T-/T+ with s/m/h units), a status word, and an empty state. These tests
// mount the real compiled component (plus its LineBadge child) under jsdom and
// assert the rendered rows, countdown unit boundaries, status mapping, and the
// empty state. Countdowns are relative to Date.now(), so fixtures use offsets.

const dom = installDom();
afterAll(() => dom.teardown());

type Task = {
	id: string;
	type: string;
	displayName: string;
	status: string;
	schedule: string | null;
	hostName: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
};

function task(partial: Partial<Task> & { id: string }): Task {
	return {
		type: "cron",
		displayName: "Task",
		status: "pending",
		schedule: "every 1h",
		hostName: "hub",
		next_run_at: null,
		last_run_at: null,
		...partial,
	};
}

/** ISO timestamp `secondsFromNow` ahead of (or behind, if negative) now. */
function at(secondsFromNow: number): string {
	return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

async function mountBoard(tasks: Task[]) {
	const DepartureBoard = (await import("../../components/DepartureBoard.svelte")).default;
	return dom.mount(DepartureBoard, { tasks });
}

describe("DepartureBoard", () => {
	it("shows the empty state when no tasks are active or upcoming", async () => {
		const { target, unmount } = await mountBoard([]);
		await dom.settle();
		expect(target.textContent).toContain("No tasks scheduled.");
		expect(target.querySelectorAll(".row").length).toBe(0);
		// Static chrome is always present.
		expect(target.textContent).toContain("DEPARTURES");
		unmount();
	});

	it("renders a row per upcoming task with its destination, schedule and host", async () => {
		const tasks = [
			task({
				id: "t1",
				displayName: "nightly sweep",
				schedule: "every 1d",
				hostName: "spoke-7",
				next_run_at: at(300),
			}),
		];
		const { target, unmount } = await mountBoard(tasks);
		await dom.settle();
		const rows = target.querySelectorAll(".row");
		expect(rows.length).toBe(1);
		expect(target.querySelector(".destination")?.textContent).toContain("nightly sweep");
		expect(target.querySelector(".schedule")?.textContent).toContain("every 1d");
		expect(target.querySelector(".host")?.textContent).toContain("spoke-7");
		unmount();
	});

	it("maps status to the departure-board vocabulary", async () => {
		const tasks = [
			task({ id: "run", status: "running", next_run_at: at(100) }),
			task({ id: "pend", status: "pending", next_run_at: at(200) }),
		];
		const { target, unmount } = await mountBoard(tasks);
		await dom.settle();
		const statuses = [...target.querySelectorAll(".status")].map((s) => s.textContent?.trim());
		expect(statuses).toContain("ON TIME"); // running
		expect(statuses).toContain("SCHEDULED"); // pending
		unmount();
	});

	it("renders the countdown in seconds, minutes and hours for future runs", async () => {
		const tasks = [
			task({ id: "sec", status: "pending", next_run_at: at(30) }), // < 60s → T-30s
			task({ id: "min", status: "pending", next_run_at: at(5 * 60) }), // < 60m → T-05m
			task({ id: "hr", status: "pending", next_run_at: at(3 * 3600) }), // → T-03h
		];
		const { target, unmount } = await mountBoard(tasks);
		await dom.settle();
		const departs = [...target.querySelectorAll(".depart")].map((d) => d.textContent?.trim());
		// Seconds bucket (allow ±1s for test execution drift).
		expect(departs.some((d) => /^T-\d{2}s$/.test(d ?? ""))).toBe(true);
		// Minutes bucket: 5m ahead lands on T-04m or T-05m depending on sub-second drift.
		expect(departs.some((d) => /^T-0[45]m$/.test(d ?? ""))).toBe(true);
		expect(departs.some((d) => /^T-0[23]h$/.test(d ?? ""))).toBe(true);
		unmount();
	});

	it("shows a near-now run as T+00s and em-dash for a null next_run_at", async () => {
		const tasks = [
			// running tasks rank even with no next_run_at; countdown of null → em-dash.
			task({ id: "now", status: "running", next_run_at: null }),
		];
		const { target, unmount } = await mountBoard(tasks);
		await dom.settle();
		expect(target.querySelector(".depart")?.textContent?.trim()).toBe("—");
		unmount();
	});

	it("renders T+ countdowns (seconds, minutes, hours past) for overdue runs", async () => {
		// Running/claimed tasks rank even with a past next_run_at, so the
		// negative-diff (overdue) countdown branch is exercised across units.
		const tasks = [
			task({ id: "sec", status: "running", next_run_at: at(-30) }), // < 60s past → T+NNs
			task({ id: "min", status: "running", next_run_at: at(-5 * 60) }), // < 60m past → T+NNm
			task({ id: "hr", status: "running", next_run_at: at(-3 * 3600) }), // → T+NNh
		];
		const { target, unmount } = await mountBoard(tasks);
		await dom.settle();
		const departs = [...target.querySelectorAll(".depart")].map((d) => d.textContent?.trim());
		expect(departs.some((d) => /^T\+\d{2}s$/.test(d ?? ""))).toBe(true);
		expect(departs.some((d) => /^T\+0[45]m$/.test(d ?? ""))).toBe(true);
		expect(departs.some((d) => /^T\+0[23]h$/.test(d ?? ""))).toBe(true);
		unmount();
	});

	it("falls back to the uppercased raw status for unmapped values", async () => {
		const tasks = [task({ id: "weird", status: "zombie", next_run_at: at(100) })];
		const { target, unmount } = await mountBoard(tasks);
		await dom.settle();
		expect(target.querySelector(".status")?.textContent?.trim()).toBe("ZOMBIE");
		unmount();
	});
});
