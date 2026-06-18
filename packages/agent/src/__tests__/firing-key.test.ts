import { describe, expect, it } from "bun:test";
import {
	computeFiringKey,
	deriveFiringArtifactId,
	deriveFiringWakeupIds,
} from "../task-resolution";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_USE_RE = /^tooluse_[a-zA-Z0-9_-]+$/;

describe("computeFiringKey", () => {
	it("returns null when there is no scheduled instant (event tasks)", () => {
		expect(computeFiringKey("task-abc", null)).toBeNull();
	});

	it("is deterministic and folds in both the task id and the scheduled instant", () => {
		const a = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		const b = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		expect(a).toBe(b);
		expect(a).toContain("task-abc");
		expect(a).toContain("2026-06-18T02:00:00.000Z");
	});

	it("distinguishes firings of the same task at different instants", () => {
		const first = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		const second = computeFiringKey("task-abc", "2026-06-18T02:30:00.000Z");
		expect(first).not.toBe(second);
	});

	it("distinguishes different tasks at the same instant", () => {
		const a = computeFiringKey("task-a", "2026-06-18T02:00:00.000Z");
		const b = computeFiringKey("task-b", "2026-06-18T02:00:00.000Z");
		expect(a).not.toBe(b);
	});
});

describe("deriveFiringWakeupIds", () => {
	it("is deterministic for a given firing key (the cross-host convergence property)", () => {
		const key = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		if (key === null) throw new Error("expected non-null firing key");
		const hostA = deriveFiringWakeupIds(key);
		const hostB = deriveFiringWakeupIds(key);
		expect(hostA).toEqual(hostB);
	});

	it("derives four distinct ids for one firing", () => {
		const key = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		if (key === null) throw new Error("expected non-null firing key");
		const ids = deriveFiringWakeupIds(key);
		const set = new Set([
			ids.wakeupMessageId,
			ids.toolCallMessageId,
			ids.toolResultMessageId,
			ids.toolUseId,
		]);
		expect(set.size).toBe(4);
	});

	it("produces wire-legal message UUIDs and a tool_use id within the provider charset/length caps", () => {
		const key = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		if (key === null) throw new Error("expected non-null firing key");
		const ids = deriveFiringWakeupIds(key);
		expect(ids.wakeupMessageId).toMatch(UUID_RE);
		expect(ids.toolCallMessageId).toMatch(UUID_RE);
		expect(ids.toolResultMessageId).toMatch(UUID_RE);
		expect(ids.toolUseId).toMatch(TOOL_USE_RE);
		expect(ids.toolUseId.length).toBeLessThanOrEqual(64);
		// `tooluse_` (8) + 22-char body, matching the random path's shape.
		expect(ids.toolUseId.length).toBe(30);
	});

	it("does not collide across different firings", () => {
		const k1 = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
		const k2 = computeFiringKey("task-abc", "2026-06-18T02:30:00.000Z");
		if (k1 === null || k2 === null) throw new Error("expected non-null firing keys");
		const a = deriveFiringWakeupIds(k1);
		const b = deriveFiringWakeupIds(k2);
		expect(a.wakeupMessageId).not.toBe(b.wakeupMessageId);
		expect(a.toolCallMessageId).not.toBe(b.toolCallMessageId);
		expect(a.toolResultMessageId).not.toBe(b.toolResultMessageId);
		expect(a.toolUseId).not.toBe(b.toolUseId);
	});
});

describe("deriveFiringArtifactId", () => {
	const key = computeFiringKey("task-abc", "2026-06-18T02:00:00.000Z");
	if (key === null) throw new Error("expected non-null firing key");

	it("is deterministic for a given (firing key, artifact) — the cross-host convergence property", () => {
		const hostA = deriveFiringArtifactId(key, "quiescence");
		const hostB = deriveFiringArtifactId(key, "quiescence");
		expect(hostA).toBe(hostB);
	});

	it("produces a wire-legal message UUID", () => {
		expect(deriveFiringArtifactId(key, "failalert")).toMatch(UUID_RE);
	});

	it("distinguishes artifacts of the same firing so they don't overwrite each other", () => {
		const quiescence = deriveFiringArtifactId(key, "quiescence");
		const failalert = deriveFiringArtifactId(key, "failalert");
		expect(quiescence).not.toBe(failalert);
	});

	it("does not collide with the wakeup-triplet ids of the same firing", () => {
		const wakeup = deriveFiringWakeupIds(key);
		const artifact = deriveFiringArtifactId(key, "quiescence");
		expect(artifact).not.toBe(wakeup.wakeupMessageId);
		expect(artifact).not.toBe(wakeup.toolCallMessageId);
		expect(artifact).not.toBe(wakeup.toolResultMessageId);
	});

	it("does not collide across different firings for the same artifact", () => {
		const k2 = computeFiringKey("task-abc", "2026-06-18T02:30:00.000Z");
		if (k2 === null) throw new Error("expected non-null firing key");
		expect(deriveFiringArtifactId(key, "quiescence")).not.toBe(
			deriveFiringArtifactId(k2, "quiescence"),
		);
	});
});
