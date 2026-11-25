import { describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import { resolveEffectiveModelHint } from "../effective-model-hint";

function setup() {
	const db = createCoreTestDb();
	const now = new Date().toISOString();
	db.run("INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES ('u','U',?,?)", [
		now,
		now,
	]);
	db.run(
		"INSERT INTO threads (id,user_id,interface,host_origin,created_at,last_message_at,modified_at,model_hint) VALUES ('th','u','web','s',?,?,?,'thread-model')",
		[now, now, now],
	);
	db.run(
		"INSERT INTO tasks (id,type,status,trigger_spec,created_at,modified_at,thread_id,model_hint) VALUES ('task','event','running','event:x',?,?, 'th','task-model')",
		[now, now],
	);
	return db;
}

describe("resolveEffectiveModelHint", () => {
	it("uses task, then thread, then node default precedence", () => {
		const db = setup();
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("task-model");
		db.run("UPDATE tasks SET model_hint = NULL WHERE id = 'task'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("thread-model");
		db.run("UPDATE threads SET model_hint = NULL WHERE id = 'th'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("default");
		db.close();
	});
});

describe("resolveEffectiveModelHint with thread and task liveness", () => {
	it("keeps the task hint when the associated thread is soft-deleted", () => {
		const db = setup();
		db.run("UPDATE threads SET deleted = 1 WHERE id = 'th'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("task-model");
		db.close();
	});

	it("keeps the task hint when the associated thread row does not exist yet", () => {
		const db = setup();
		db.run("UPDATE tasks SET thread_id = 'not-yet-created' WHERE id = 'task'");
		expect(resolveEffectiveModelHint(db, "not-yet-created", "default", "task")).toBe("task-model");
		db.close();
	});

	it("never falls back to a soft-deleted thread's hint", () => {
		const db = setup();
		db.run("UPDATE tasks SET model_hint = NULL WHERE id = 'task'");
		db.run("UPDATE threads SET deleted = 1 WHERE id = 'th'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("default");
		expect(resolveEffectiveModelHint(db, "th", "default")).toBe("default");
		db.close();
	});

	it("ignores a soft-deleted task and falls back to the live thread hint", () => {
		const db = setup();
		db.run("UPDATE tasks SET deleted = 1 WHERE id = 'task'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("thread-model");
		db.close();
	});

	it("ignores a task bound to a different thread", () => {
		const db = setup();
		db.run("UPDATE tasks SET thread_id = 'other-thread' WHERE id = 'task'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("thread-model");
		db.run("UPDATE threads SET deleted = 1 WHERE id = 'th'");
		expect(resolveEffectiveModelHint(db, "th", "default", "task")).toBe("default");
		db.close();
	});

	it("uses the live thread hint when no task id is given", () => {
		const db = setup();
		expect(resolveEffectiveModelHint(db, "th", "default")).toBe("thread-model");
		expect(resolveEffectiveModelHint(db, "missing", "default")).toBe("default");
		db.close();
	});
});
