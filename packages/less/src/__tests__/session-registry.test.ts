import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRememberedLocalSessions, rememberLocalSession } from "../acp/session-registry";

describe("local session registry", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "bound-less-registry-"));
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
	});

	it("persists records to local-sessions.json (not the legacy acp-sessions.json)", () => {
		rememberLocalSession(configDir, "thread-1", "/work/repo");

		expect(existsSync(join(configDir, "local-sessions.json"))).toBe(true);
		expect(existsSync(join(configDir, "acp-sessions.json"))).toBe(false);

		const parsed = JSON.parse(readFileSync(join(configDir, "local-sessions.json"), "utf-8"));
		expect(parsed.version).toBe(1);
		expect(parsed.sessions).toHaveLength(1);
		expect(parsed.sessions[0]).toMatchObject({ sessionId: "thread-1", cwd: "/work/repo" });
	});

	it("round-trips through the lister", () => {
		rememberLocalSession(configDir, "thread-1", "/work/a");
		rememberLocalSession(configDir, "thread-2", "/work/b");

		const records = listRememberedLocalSessions(configDir);
		expect(records.map((r) => r.sessionId).sort()).toEqual(["thread-1", "thread-2"]);
	});

	it("dedups by sessionId, keeping the latest cwd", () => {
		rememberLocalSession(configDir, "thread-1", "/work/old");
		rememberLocalSession(configDir, "thread-1", "/work/new");

		const records = listRememberedLocalSessions(configDir);
		expect(records).toHaveLength(1);
		expect(records[0].cwd).toBe("/work/new");
	});

	it("returns an empty list when no registry file exists", () => {
		expect(listRememberedLocalSessions(configDir)).toEqual([]);
	});
});
