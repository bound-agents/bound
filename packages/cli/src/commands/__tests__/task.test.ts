import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { taskUpdate } from "../task.js";

const SITE_ID = "test-site";

describe("task commands", () => {
	let db: Database;
	let originalLog: typeof console.log;

	function setup() {
		originalLog = console.log;
		// In-memory DB: these tests pass the `db` object directly to the command
		// under test and never reopen from a path, so a file-backed temp DB only
		// adds a Windows EBUSY hazard (rmSync racing the still-closing WAL handle).
		db = new Database(":memory:");
		applySchema(db);
	}

	function seedTask(overrides: Record<string, unknown> = {}): string {
		const now = new Date().toISOString();
		const id = `task-${Math.random().toString(16).slice(2, 10)}`;
		insertRow(
			db,
			"tasks",
			{
				id,
				type: "cron",
				status: "pending",
				trigger_spec: JSON.stringify({ type: "cron", expression: "0 * * * *" }),
				payload: null,
				created_at: now,
				created_by: SITE_ID,
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
				...overrides,
			},
			SITE_ID,
		);
		return id;
	}

	afterEach(() => {
		console.log = originalLog;
		if (db) db.close();
	});

	describe("taskUpdate", () => {
		it("should set no_history with --no-history", () => {
			setup();
			console.log = () => {};
			const id = seedTask();

			taskUpdate(db, SITE_ID, [id, "--no-history"]);

			const task = db.prepare("SELECT no_history FROM tasks WHERE id = ?").get(id) as {
				no_history: number;
			};
			expect(task.no_history).toBe(1);
		});

		it("should re-enable history with --history", () => {
			setup();
			console.log = () => {};
			const id = seedTask({ no_history: 1 });

			taskUpdate(db, SITE_ID, [id, "--history"]);

			const task = db.prepare("SELECT no_history FROM tasks WHERE id = ?").get(id) as {
				no_history: number;
			};
			expect(task.no_history).toBe(0);
		});

		it("should reject --no-history and --history together", () => {
			setup();
			const id = seedTask();
			expect(() => taskUpdate(db, SITE_ID, [id, "--no-history", "--history"])).toThrow(
				/mutually exclusive/,
			);
		});

		it("should set and clear model_hint", () => {
			setup();
			console.log = () => {};
			const id = seedTask();

			taskUpdate(db, SITE_ID, [id, "--model", "opus"]);
			let task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get(id) as {
				model_hint: string | null;
			};
			expect(task.model_hint).toBe("opus");

			taskUpdate(db, SITE_ID, [id, "--model", ""]);
			task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get(id) as {
				model_hint: string | null;
			};
			expect(task.model_hint).toBeNull();
		});

		it("should set alert_threshold", () => {
			setup();
			console.log = () => {};
			const id = seedTask();

			taskUpdate(db, SITE_ID, [id, "--alert-threshold", "7"]);

			const task = db.prepare("SELECT alert_threshold FROM tasks WHERE id = ?").get(id) as {
				alert_threshold: number;
			};
			expect(task.alert_threshold).toBe(7);
		});

		it("should reject alert_threshold <= 0", () => {
			setup();
			const id = seedTask();
			expect(() => taskUpdate(db, SITE_ID, [id, "--alert-threshold", "0"])).toThrow(
				/greater than 0/,
			);
		});

		it("should throw when no id is provided", () => {
			setup();
			expect(() => taskUpdate(db, SITE_ID, ["--no-history"])).toThrow(/--id is required/);
		});

		it("should throw when the task does not exist", () => {
			setup();
			expect(() => taskUpdate(db, SITE_ID, ["missing-id", "--no-history"])).toThrow(/not found/);
		});

		it("should throw when no mutable fields are provided", () => {
			setup();
			const id = seedTask();
			expect(() => taskUpdate(db, SITE_ID, [id])).toThrow(/at least one/);
		});
	});
});
