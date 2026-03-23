import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { MemoryTracker, wrapWithMemoryTracking } from "../memory-tracker";

describe("MemoryTracker", () => {
	test("starts with zero memory usage", () => {
		const tracker = new MemoryTracker();
		expect(tracker.getMemoryUsage()).toBe(0);
		expect(tracker.isOverThreshold()).toBe(false);
	});

	test("tracks file writes correctly", () => {
		const tracker = new MemoryTracker();
		tracker.trackWrite("/home/user/file.txt", "hello world");
		expect(tracker.getMemoryUsage()).toBe(Buffer.byteLength("hello world"));
	});

	test("handles file overwrites by adjusting total", () => {
		const tracker = new MemoryTracker();
		tracker.trackWrite("/home/user/file.txt", "short");
		const initialUsage = tracker.getMemoryUsage();

		tracker.trackWrite("/home/user/file.txt", "a much longer string");
		expect(tracker.getMemoryUsage()).toBe(Buffer.byteLength("a much longer string"));
		expect(tracker.getMemoryUsage()).toBeGreaterThan(initialUsage);
	});

	test("handles file removal by subtracting from total", () => {
		const tracker = new MemoryTracker();
		tracker.trackWrite("/home/user/file.txt", "hello");
		tracker.trackRemove("/home/user/file.txt");
		expect(tracker.getMemoryUsage()).toBe(0);
	});

	test("removing non-existent file is a no-op", () => {
		const tracker = new MemoryTracker();
		tracker.trackRemove("/home/user/nonexistent.txt");
		expect(tracker.getMemoryUsage()).toBe(0);
	});

	test("isOverThreshold returns true when usage exceeds threshold", () => {
		const tracker = new MemoryTracker(10); // 10 bytes
		tracker.trackWrite("/home/user/file.txt", "this is more than ten bytes");
		expect(tracker.isOverThreshold()).toBe(true);
	});

	test("isOverThreshold returns false when usage is at threshold", () => {
		const tracker = new MemoryTracker(10);
		tracker.trackWrite("/home/user/file.txt", "1234567890"); // exactly 10
		expect(tracker.isOverThreshold()).toBe(false);
	});

	test("checkMemoryThreshold returns full status", () => {
		const tracker = new MemoryTracker(1024);
		tracker.trackWrite("/home/user/file.txt", "hello");

		const result = tracker.checkMemoryThreshold();
		expect(result.overThreshold).toBe(false);
		expect(result.usageBytes).toBe(Buffer.byteLength("hello"));
		expect(result.thresholdBytes).toBe(1024);
	});

	test("defaults to 50MB threshold", () => {
		const tracker = new MemoryTracker();
		expect(tracker.getThresholdBytes()).toBe(50 * 1024 * 1024);
	});

	test("tracks Uint8Array content correctly", () => {
		const tracker = new MemoryTracker();
		const buffer = new Uint8Array([1, 2, 3, 4, 5]);
		tracker.trackWrite("/home/user/file.bin", buffer);
		expect(tracker.getMemoryUsage()).toBe(5);
	});

	test("tracks multiple files independently", () => {
		const tracker = new MemoryTracker();
		tracker.trackWrite("/home/user/a.txt", "aaa");
		tracker.trackWrite("/home/user/b.txt", "bbbbb");
		expect(tracker.getMemoryUsage()).toBe(8);

		tracker.trackRemove("/home/user/a.txt");
		expect(tracker.getMemoryUsage()).toBe(5);
	});
});

describe("wrapWithMemoryTracking", () => {
	test("intercepts writeFile and tracks memory", async () => {
		const fs = new InMemoryFs();
		const tracker = new MemoryTracker();
		wrapWithMemoryTracking(fs, tracker);

		await fs.writeFile("/test.txt", "hello world");
		expect(tracker.getMemoryUsage()).toBe(Buffer.byteLength("hello world"));

		// Verify the file was actually written
		const content = await fs.readFile("/test.txt");
		expect(content).toBe("hello world");
	});

	test("intercepts rm and reduces memory", async () => {
		const fs = new InMemoryFs();
		const tracker = new MemoryTracker();
		wrapWithMemoryTracking(fs, tracker);

		await fs.writeFile("/test.txt", "hello world");
		expect(tracker.getMemoryUsage()).toBeGreaterThan(0);

		await fs.rm("/test.txt");
		expect(tracker.getMemoryUsage()).toBe(0);
	});

	test("intercepts appendFile and updates memory", async () => {
		const fs = new InMemoryFs();
		const tracker = new MemoryTracker();
		wrapWithMemoryTracking(fs, tracker);

		await fs.writeFile("/test.txt", "hello");
		const beforeAppend = tracker.getMemoryUsage();

		await fs.appendFile("/test.txt", " world");
		expect(tracker.getMemoryUsage()).toBeGreaterThan(beforeAppend);
	});

	test("returns the same filesystem reference", () => {
		const fs = new InMemoryFs();
		const tracker = new MemoryTracker();
		const wrapped = wrapWithMemoryTracking(fs, tracker);
		expect(wrapped).toBe(fs);
	});
});
