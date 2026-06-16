import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type IsoSessionRecord,
	loadIsoSessions,
	recordIsoSession,
	removeIsoSession,
	selectOrphans,
	writeIsoSessions,
} from "../tools/iso-session-state";

let dir: string;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "iso-state-"));
	statePath = join(dir, "iso-sessions.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function rec(overrides: Partial<IsoSessionRecord> = {}): IsoSessionRecord {
	return {
		sandboxId: "iso:wxc-aaaa1111",
		agentUser: "A1-B2",
		ownerPid: 1234,
		cwd: "C:\\proj",
		createdAt: "2026-06-15T00:00:00.000Z",
		...overrides,
	};
}

describe("iso-session-state", () => {
	it("returns [] when the state file does not exist", () => {
		expect(loadIsoSessions(statePath)).toEqual([]);
	});

	it("returns [] (and does not throw) on corrupt JSON", () => {
		writeFileSync(statePath, "{ not valid json", "utf8");
		expect(loadIsoSessions(statePath)).toEqual([]);
	});

	it("returns [] when the file holds valid JSON of the wrong shape", () => {
		writeFileSync(statePath, JSON.stringify({ nope: true }), "utf8");
		expect(loadIsoSessions(statePath)).toEqual([]);
	});

	it("round-trips a record through record + load", () => {
		recordIsoSession(statePath, rec());
		const loaded = loadIsoSessions(statePath);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.sandboxId).toBe("iso:wxc-aaaa1111");
		expect(loaded[0]?.ownerPid).toBe(1234);
	});

	it("appends distinct sessions and de-dupes on sandboxId (last write wins)", () => {
		recordIsoSession(statePath, rec({ sandboxId: "iso:a", ownerPid: 1 }));
		recordIsoSession(statePath, rec({ sandboxId: "iso:b", ownerPid: 2 }));
		recordIsoSession(statePath, rec({ sandboxId: "iso:a", ownerPid: 99 }));
		const loaded = loadIsoSessions(statePath);
		expect(loaded).toHaveLength(2);
		expect(loaded.find((r) => r.sandboxId === "iso:a")?.ownerPid).toBe(99);
	});

	it("removes a single session by sandboxId, leaving the rest", () => {
		recordIsoSession(statePath, rec({ sandboxId: "iso:a" }));
		recordIsoSession(statePath, rec({ sandboxId: "iso:b" }));
		removeIsoSession(statePath, "iso:a");
		const loaded = loadIsoSessions(statePath);
		expect(loaded.map((r) => r.sandboxId)).toEqual(["iso:b"]);
	});

	it("remove on a missing sandboxId is a no-op", () => {
		recordIsoSession(statePath, rec({ sandboxId: "iso:a" }));
		removeIsoSession(statePath, "iso:does-not-exist");
		expect(loadIsoSessions(statePath)).toHaveLength(1);
	});

	it("writeIsoSessions overwrites atomically and is readable back", () => {
		writeIsoSessions(statePath, [rec({ sandboxId: "iso:x" })]);
		expect(readFileSync(statePath, "utf8")).toContain("iso:x");
		writeIsoSessions(statePath, []);
		expect(loadIsoSessions(statePath)).toEqual([]);
	});

	describe("selectOrphans", () => {
		it("selects records whose owner pid is dead", () => {
			const records = [
				rec({ sandboxId: "iso:dead", ownerPid: 10 }),
				rec({ sandboxId: "iso:live", ownerPid: 20 }),
			];
			const orphans = selectOrphans(records, (pid) => pid === 20);
			expect(orphans.map((r) => r.sandboxId)).toEqual(["iso:dead"]);
		});

		it("never selects a record whose owner pid is alive (concurrent instance safety)", () => {
			const records = [rec({ sandboxId: "iso:live", ownerPid: 4242 })];
			const orphans = selectOrphans(records, () => true);
			expect(orphans).toEqual([]);
		});

		it("selects nothing from an empty set", () => {
			expect(selectOrphans([], () => false)).toEqual([]);
		});
	});
});
