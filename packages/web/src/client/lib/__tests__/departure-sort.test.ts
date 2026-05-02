import { describe, expect, it } from "bun:test";
import { rankDepartures } from "../departure-sort";

interface Task {
	id: string;
	status: string;
	next_run_at: string | null;
}

describe("rankDepartures", () => {
	it("should filter out completed and cancelled tasks", () => {
		const tasks: Task[] = [
			{ id: "1", status: "completed", next_run_at: null },
			{ id: "2", status: "cancelled", next_run_at: null },
			{ id: "3", status: "pending", next_run_at: "2026-04-14T10:00:00Z" },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(1);
		expect(ranked[0].id).toBe("3");
	});

	it("should sort running before failed before pending", () => {
		const sameTime = "2026-04-14T10:00:00Z";
		const tasks: Task[] = [
			{ id: "pending", status: "pending", next_run_at: sameTime },
			{ id: "running", status: "running", next_run_at: sameTime },
			{ id: "failed", status: "failed", next_run_at: sameTime },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked[0].id).toBe("running");
		expect(ranked[1].id).toBe("failed");
		expect(ranked[2].id).toBe("pending");
	});

	it("should sort by next_run_at ascending within same status", () => {
		const tasks: Task[] = [
			{ id: "later", status: "pending", next_run_at: "2026-04-14T15:00:00Z" },
			{ id: "sooner", status: "pending", next_run_at: "2026-04-14T10:00:00Z" },
			{ id: "middle", status: "pending", next_run_at: "2026-04-14T12:00:00Z" },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked[0].id).toBe("sooner");
		expect(ranked[1].id).toBe("middle");
		expect(ranked[2].id).toBe("later");
	});

	it("should sort pending tasks with null next_run_at after those with times", () => {
		const tasks: Task[] = [
			{ id: "no-time", status: "pending", next_run_at: null },
			{ id: "has-time", status: "pending", next_run_at: "2026-04-14T10:00:00Z" },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked[0].id).toBe("has-time");
		expect(ranked[1].id).toBe("no-time");
	});

	it("should limit to 6 results by default", () => {
		const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
			id: `task-${i}`,
			status: "pending",
			next_run_at: `2026-04-14T${String(10 + i).padStart(2, "0")}:00:00Z`,
		}));

		const ranked = rankDepartures(tasks);

		expect(ranked).toHaveLength(6);
	});

	it("should accept a custom limit", () => {
		const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
			id: `task-${i}`,
			status: "pending",
			next_run_at: `2026-04-14T${String(10 + i).padStart(2, "0")}:00:00Z`,
		}));

		const ranked = rankDepartures(tasks, 3);

		expect(ranked).toHaveLength(3);
	});

	it("should rank a pending heartbeat above a failed task with no next_run_at", () => {
		const tasks: Task[] = [
			{ id: "failed-old", status: "failed", next_run_at: null },
			{ id: "heartbeat", status: "pending", next_run_at: "2026-04-14T10:00:00Z" },
		];

		const ranked = rankDepartures(tasks);

		expect(ranked[0].id).toBe("failed-old");
		expect(ranked[1].id).toBe("heartbeat");
	});

	it("should not mutate input array", () => {
		const tasks: Task[] = [
			{ id: "2", status: "pending", next_run_at: "2026-04-14T15:00:00Z" },
			{ id: "1", status: "running", next_run_at: "2026-04-14T10:00:00Z" },
		];

		const original = [...tasks];
		rankDepartures(tasks);

		expect(tasks).toEqual(original);
	});
});
