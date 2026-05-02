import { describe, expect, it } from "bun:test";
import { rankDepartures } from "../departure-sort";

interface Task {
	id: string;
	status: string;
	next_run_at: string | null;
}

function futureTime(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function pastTime(offsetMs: number): string {
	return new Date(Date.now() - offsetMs).toISOString();
}

const HOUR = 3_600_000;

describe("rankDepartures", () => {
	it("should filter out completed and cancelled tasks", () => {
		const tasks: Task[] = [
			{ id: "1", status: "completed", next_run_at: null },
			{ id: "2", status: "cancelled", next_run_at: null },
			{ id: "3", status: "pending", next_run_at: futureTime(HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(1);
		expect(ranked[0].id).toBe("3");
	});

	it("should sort active tasks (running/claimed) above non-active", () => {
		const t = futureTime(HOUR);
		const tasks: Task[] = [
			{ id: "pending", status: "pending", next_run_at: t },
			{ id: "running", status: "running", next_run_at: t },
			{ id: "claimed", status: "claimed", next_run_at: t },
		];

		const ranked = rankDepartures(tasks);

		const activeIds = ranked
			.slice(0, 2)
			.map((t) => t.id)
			.sort();
		expect(activeIds).toEqual(["claimed", "running"]);
		expect(ranked[2].id).toBe("pending");
	});

	it("should sort by next_run_at ascending within same status", () => {
		const tasks: Task[] = [
			{ id: "later", status: "pending", next_run_at: futureTime(3 * HOUR) },
			{ id: "sooner", status: "pending", next_run_at: futureTime(HOUR) },
			{ id: "middle", status: "pending", next_run_at: futureTime(2 * HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked[0].id).toBe("sooner");
		expect(ranked[1].id).toBe("middle");
		expect(ranked[2].id).toBe("later");
	});

	it("should limit to 6 results by default", () => {
		const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
			id: `task-${i}`,
			status: "pending",
			next_run_at: futureTime((i + 1) * HOUR),
		}));

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(6);
	});

	it("should accept a custom limit", () => {
		const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
			id: `task-${i}`,
			status: "pending",
			next_run_at: futureTime((i + 1) * HOUR),
		}));

		const ranked = rankDepartures(tasks, 3);

		expect(ranked).toHaveLength(3);
	});

	it("should rank a pending heartbeat above a failed task with no next_run_at", () => {
		const tasks: Task[] = [
			{ id: "failed-old", status: "failed", next_run_at: null },
			{ id: "heartbeat", status: "pending", next_run_at: futureTime(HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(1);
		expect(ranked[0].id).toBe("heartbeat");
	});

	it("should keep running tasks above pending even when pending has earlier next_run_at", () => {
		const tasks: Task[] = [
			{ id: "pending-soon", status: "pending", next_run_at: futureTime(HOUR) },
			{ id: "running-later", status: "running", next_run_at: futureTime(3 * HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked[0].id).toBe("running-later");
		expect(ranked[1].id).toBe("pending-soon");
	});

	it("should exclude failed tasks that are not running or upcoming", () => {
		const tasks: Task[] = [
			{ id: "failed-past-1", status: "failed", next_run_at: pastTime(HOUR) },
			{ id: "failed-past-2", status: "failed", next_run_at: pastTime(2 * HOUR) },
			{ id: "failed-past-3", status: "failed", next_run_at: pastTime(3 * HOUR) },
			{ id: "failed-past-4", status: "failed", next_run_at: pastTime(4 * HOUR) },
			{ id: "failed-past-5", status: "failed", next_run_at: pastTime(5 * HOUR) },
			{ id: "failed-past-6", status: "failed", next_run_at: pastTime(6 * HOUR) },
			{ id: "heartbeat", status: "pending", next_run_at: futureTime(HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked.some((t) => t.id === "heartbeat")).toBe(true);
	});

	it("should keep running tasks even with past next_run_at", () => {
		const tasks: Task[] = [
			{ id: "running-overdue", status: "running", next_run_at: pastTime(HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(1);
		expect(ranked[0].id).toBe("running-overdue");
	});

	it("should exclude pending tasks with null next_run_at", () => {
		const tasks: Task[] = [
			{ id: "no-time", status: "pending", next_run_at: null },
			{ id: "has-time", status: "pending", next_run_at: futureTime(HOUR) },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(1);
		expect(ranked[0].id).toBe("has-time");
	});

	it("should not mutate input array", () => {
		const tasks: Task[] = [
			{ id: "2", status: "pending", next_run_at: futureTime(2 * HOUR) },
			{ id: "1", status: "running", next_run_at: futureTime(HOUR) },
		];

		const original = [...tasks];
		rankDepartures(tasks);

		expect(tasks).toEqual(original);
	});
});
