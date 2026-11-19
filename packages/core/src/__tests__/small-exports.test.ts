import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CANONICAL_RELATIONS, InvalidRelationError } from "../memory-relations";
import { PayloadTooLargeError } from "../relay";
import { ThreadExecutor } from "../thread-executor";
import { createCoreTestDb } from "./test-database";

describe("PayloadTooLargeError", () => {
	it("is an Error carrying the size/limit in its message and a stable name", () => {
		const err = new PayloadTooLargeError(5000, 1024);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("PayloadTooLargeError");
		expect(err.message).toBe("Relay payload size 5000 exceeds limit 1024");
	});

	it("is throwable and catchable as its own class", () => {
		expect(() => {
			throw new PayloadTooLargeError(2, 1);
		}).toThrow(PayloadTooLargeError);
	});
});

describe("InvalidRelationError", () => {
	it("exposes the offending relation and lists the canonical set in its message", () => {
		const err = new InvalidRelationError("befriends");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("InvalidRelationError");
		expect(err.rel).toBe("befriends");
		expect(err.message).toContain('Invalid relation "befriends"');
		// Every canonical relation is named so the caller can pick a valid one.
		for (const rel of CANONICAL_RELATIONS) {
			expect(err.message).toContain(rel);
		}
		expect(err.message).toContain("--context");
	});
});

describe("ThreadExecutor.activeThreads", () => {
	const silentLogger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
	} as unknown as ConstructorParameters<typeof ThreadExecutor>[1];

	function makeDb(): Database {
		const db = new Database(":memory:");
		// hasPending reads pending dispatch rows; an empty messages/dispatch schema
		// is enough for the no-pending path exercised here.
		return db;
	}

	it("starts empty and exposes a read-only set", () => {
		const executor = new ThreadExecutor(makeDb(), silentLogger);
		expect(executor.activeThreads.size).toBe(0);
		expect([...executor.activeThreads]).toEqual([]);
	});

	it("reflects the active thread id for the duration of an execute() run", async () => {
		// Real schema so hasPending / resetProcessingForThread can query dispatch_queue;
		// no pending rows → the loop runs once and releases the lock.
		const db = createCoreTestDb();
		const executor = new ThreadExecutor(db, silentLogger);

		let snapshotDuringRun: string[] = [];
		await executor.execute("thread-x", async () => {
			snapshotDuringRun = [...executor.activeThreads];
			return {};
		});

		expect(snapshotDuringRun).toEqual(["thread-x"]);
		// Lock released after the run resolves.
		expect(executor.activeThreads.size).toBe(0);
	});
});
