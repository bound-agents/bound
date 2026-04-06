import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bound/shared";
import { createDatabase } from "../database";
import { acknowledgeBatch, claimPending, enqueueMessage } from "../dispatch";
import { applySchema } from "../schema";
import { ThreadExecutor } from "../thread-executor";
import type { ExecutorRunResult } from "../thread-executor";

let db: ReturnType<typeof createDatabase>;
let dbPath: string;
let executor: ThreadExecutor;
let siteId: string;

const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
	executor = new ThreadExecutor(db, noopLogger);
	siteId = randomUUID();
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

/** Helper: claim and acknowledge all pending messages for a thread */
function drainOnce(threadId: string): string[] {
	const claimed = claimPending(db, threadId, siteId);
	const ids = claimed.map((e) => e.message_id);
	if (ids.length > 0) acknowledgeBatch(db, ids);
	return ids;
}

describe("ThreadExecutor", () => {
	describe("lock prevents concurrent execution", () => {
		it("returns immediately if thread is already locked", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let concurrentRan = false;

			await executor.execute(threadId, async () => {
				// While we hold the lock, try a concurrent execute
				await executor.execute(threadId, async () => {
					concurrentRan = true;
					drainOnce(threadId);
					return {};
				});
				drainOnce(threadId);
				return {};
			});

			expect(concurrentRan).toBe(false);
		});

		it("allows execution on different threads concurrently", async () => {
			const thread1 = randomUUID();
			const thread2 = randomUUID();
			enqueueMessage(db, randomUUID(), thread1);
			enqueueMessage(db, randomUUID(), thread2);

			const order: string[] = [];

			await Promise.all([
				executor.execute(thread1, async () => {
					order.push("thread1");
					drainOnce(thread1);
					return {};
				}),
				executor.execute(thread2, async () => {
					order.push("thread2");
					drainOnce(thread2);
					return {};
				}),
			]);

			expect(order).toContain("thread1");
			expect(order).toContain("thread2");
		});
	});

	describe("drain loop", () => {
		it("runs once when no new messages arrive", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let iterations = 0;

			await executor.execute(threadId, async () => {
				iterations++;
				drainOnce(threadId);
				return {};
			});

			expect(iterations).toBe(1);
		});

		it("continues draining when new messages arrive between iterations", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let iterations = 0;

			await executor.execute(threadId, async () => {
				iterations++;
				drainOnce(threadId);
				if (iterations === 1) {
					// Simulate new message arriving during inference
					enqueueMessage(db, randomUUID(), threadId);
				}
				return {};
			});

			// Two iterations: original message, then the new one
			expect(iterations).toBe(2);
		});
	});

	describe("yielded result", () => {
		it("triggers resetProcessingForThread and continues", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let iterations = 0;

			await executor.execute(threadId, async () => {
				iterations++;
				if (iterations === 1) {
					// Claim but don't acknowledge — yield resets them to pending
					claimPending(db, threadId, siteId);
					return { yielded: true };
				}
				// Second iteration: message was reset to pending, drain it
				drainOnce(threadId);
				return {};
			});

			expect(iterations).toBe(2);
		});
	});

	describe("error handling", () => {
		it("error in runFn exits the loop and releases the lock", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let errorLogged = false;
			const errorLogger: Logger = {
				...noopLogger,
				error() {
					errorLogged = true;
				},
			};
			const errorExecutor = new ThreadExecutor(db, errorLogger);

			await errorExecutor.execute(threadId, async () => {
				throw new Error("inference failed");
			});

			expect(errorLogged).toBe(true);

			// Lock should be released — can execute again
			let ranAgain = false;
			enqueueMessage(db, randomUUID(), threadId);
			await errorExecutor.execute(threadId, async () => {
				ranAgain = true;
				drainOnce(threadId);
				return {};
			});
			expect(ranAgain).toBe(true);
		});
	});

	describe("onComplete callback", () => {
		it("is called on successful runFn", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let completeCalled = false;
			let completeResult: ExecutorRunResult | null = null;

			await executor.execute(
				threadId,
				async () => {
					drainOnce(threadId);
					return { messagesCreated: 3 } as ExecutorRunResult;
				},
				async (result) => {
					completeCalled = true;
					completeResult = result;
				},
			);

			expect(completeCalled).toBe(true);
			expect(completeResult).toEqual({ messagesCreated: 3 });
		});

		it("is skipped when runFn yields", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let completeCallCount = 0;
			let iterations = 0;

			await executor.execute(
				threadId,
				async () => {
					iterations++;
					if (iterations === 1) {
						claimPending(db, threadId, siteId);
						return { yielded: true };
					}
					drainOnce(threadId);
					return {};
				},
				async () => {
					completeCallCount++;
				},
			);

			// onComplete called only for the non-yielded second iteration
			expect(iterations).toBe(2);
			expect(completeCallCount).toBe(1);
		});

		it("is not called when runFn throws", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let completeCalled = false;
			const silentExecutor = new ThreadExecutor(db, noopLogger);

			await silentExecutor.execute(
				threadId,
				async () => {
					throw new Error("boom");
				},
				async () => {
					completeCalled = true;
				},
			);

			expect(completeCalled).toBe(false);
		});
	});

	describe("isActive", () => {
		it("returns true when a thread is being executed", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let wasActive = false;

			await executor.execute(threadId, async () => {
				wasActive = executor.isActive(threadId);
				drainOnce(threadId);
				return {};
			});

			expect(wasActive).toBe(true);
			expect(executor.isActive(threadId)).toBe(false);
		});
	});

	describe("runFn timeout", () => {
		it("releases the lock when runFn exceeds the timeout", async () => {
			const threadId = randomUUID();
			enqueueMessage(db, randomUUID(), threadId);

			let errorLogged = false;
			const errorLogger: Logger = {
				...noopLogger,
				error(msg: string) {
					if (msg.includes("timeout")) errorLogged = true;
				},
			};
			const timeoutExecutor = new ThreadExecutor(db, errorLogger, {
				runTimeoutMs: 100,
			});

			await timeoutExecutor.execute(threadId, async () => {
				// Simulate a hung inference — never resolves within timeout
				await new Promise((resolve) => setTimeout(resolve, 5000));
				drainOnce(threadId);
				return {};
			});

			expect(errorLogged).toBe(true);
			expect(timeoutExecutor.isActive(threadId)).toBe(false);
		});

		it("resets processing entries on timeout so they can be re-claimed", async () => {
			const threadId = randomUUID();
			const msgId = randomUUID();
			enqueueMessage(db, msgId, threadId);

			const timeoutExecutor = new ThreadExecutor(db, noopLogger, {
				runTimeoutMs: 100,
			});

			await timeoutExecutor.execute(threadId, async () => {
				// Claim the message (sets to processing)
				claimPending(db, threadId, siteId);
				// Hang past the timeout
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return {};
			});

			// The processing entry should have been reset to pending
			const row = db.query("SELECT status FROM dispatch_queue WHERE message_id = ?").get(msgId) as {
				status: string;
			};
			expect(row.status).toBe("pending");
		});
	});
});
