import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema } from "../../schema";
import { resolveEffectiveModelHint } from "../effective-model-hint";

function setup() {
	const db = new Database(":memory:");
	applySchema(db);
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
