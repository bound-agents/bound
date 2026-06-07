import { describe, expect, it } from "bun:test";
import {
	type CrossThreadDigestEntry,
	type LiveStateAdvisory,
	type LiveStateFileEntry,
	type LiveStateInput,
	type LiveStateTaskEntry,
	renderLiveState,
} from "../summary-extraction";

describe("renderLiveState", () => {
	// Test 1: Empty input
	it("renders empty input as header, blank line, blank line, footer", () => {
		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		expect(result.lines).toEqual([
			"## Live State — pointers to canonical sources",
			"",
			"",
			"Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.",
		]);
	});

	// Test 2: Cross-thread subsystem
	it("renders cross-thread entries with [thread] label", () => {
		const entries: CrossThreadDigestEntry[] = [
			{
				title: "Project Alpha",
				messageCount: 42,
				lastUpdatedAt: "2026-05-23T10:30:00Z",
			},
			{
				title: "Project Beta",
				messageCount: 15,
				lastUpdatedAt: "2026-05-23T09:00:00Z",
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: entries,
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		const lines = result.lines;

		expect(lines).toContain(
			"- [thread] Project Alpha: 42 messages (last updated 2026-05-23T10:30:00Z)",
		);
		expect(lines).toContain(
			"- [thread] Project Beta: 15 messages (last updated 2026-05-23T09:00:00Z)",
		);
	});

	// Test 2b: cross-thread entry carrying a client session renders the executing host
	it("appends the client-session host tag to a [thread] line when the thread has a session", () => {
		const entries: CrossThreadDigestEntry[] = [
			{
				title: "On Mac",
				messageCount: 7,
				lastUpdatedAt: "2026-05-23T10:30:00Z",
				sessions: [{ hostName: "mac-studio", live: true }],
			},
			{
				title: "Stale Elsewhere",
				messageCount: 3,
				lastUpdatedAt: "2026-05-23T09:00:00Z",
				sessions: [{ hostName: "old-laptop", live: false }],
			},
			{
				title: "No Session",
				messageCount: 1,
				lastUpdatedAt: "2026-05-23T08:00:00Z",
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: entries,
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const lines = renderLiveState(input).lines;

		// Live session: host shown, no stale marker.
		expect(lines).toContain(
			"- [thread] On Mac: 7 messages (last updated 2026-05-23T10:30:00Z) [client session: mac-studio]",
		);
		// Stale session: host shown with a stale marker so it isn't mistaken for live.
		expect(lines).toContain(
			"- [thread] Stale Elsewhere: 3 messages (last updated 2026-05-23T09:00:00Z) [client session: old-laptop (stale)]",
		);
		// No session: line is byte-identical to the pre-feature format.
		expect(lines).toContain(
			"- [thread] No Session: 1 messages (last updated 2026-05-23T08:00:00Z)",
		);
	});

	// Test 3: Task subsystem
	it("renders task entries with [task] label and field names", () => {
		const taskEntries: LiveStateTaskEntry[] = [
			{
				taskId: "task-001",
				taskType: "scheduled",
				runCount: 5,
				lastRunAt: "2026-05-23T08:00:00Z",
				status: "ran",
			},
			{
				taskId: "task-002",
				taskType: "cron",
				runCount: 2,
				lastRunAt: "2026-05-23T07:30:00Z",
				status: "failed",
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries,
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		const lines = result.lines;

		expect(lines).toContain(
			"- [task] task-001 (scheduled): run_count=5, last_run_at=2026-05-23T08:00:00Z, status=ran",
		);
		expect(lines).toContain(
			"- [task] task-002 (cron): run_count=2, last_run_at=2026-05-23T07:30:00Z, status=failed",
		);
	});

	// Test 4: File subsystem
	it("renders file entries with [file] label and em-dash separator", () => {
		const fileEntries: LiveStateFileEntry[] = [
			{
				path: "/home/user/docs/report.md",
				threadTitle: "Documentation Review",
				host: "7cf34dd659c0",
				isLocal: true,
			},
			{
				path: "/home/user/code/app.ts",
				threadTitle: "Feature Development",
				host: "MSI",
				isLocal: false,
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries,
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		const lines = result.lines;

		// em-dash is U+2014; host attribution rides in a bracket suffix (R-VC28).
		// Local edits show the host plainly; remote edits are marked `, remote`.
		expect(lines).toContain(
			'- [file] /home/user/docs/report.md — last modified by thread "Documentation Review" [host: 7cf34dd659c0]',
		);
		expect(lines).toContain(
			'- [file] /home/user/code/app.ts — last modified by thread "Feature Development" [host: MSI, remote]',
		);
	});

	// Test 4b: File subsystem — null host falls back to the pre-R-VC28 line shape
	it("renders a file entry without host attribution when host is null", () => {
		const fileEntries: LiveStateFileEntry[] = [
			{
				path: "/home/user/orphan.md",
				threadTitle: "Orphaned Thread",
				host: null,
				isLocal: false,
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries,
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		expect(result.lines).toContain(
			'- [file] /home/user/orphan.md — last modified by thread "Orphaned Thread"',
		);
	});

	// Test 5: Advisory subsystem with relative time
	it("renders advisory entries with [advisory] label and relative time", () => {
		const nowMs = 1000000;
		const advisories: LiveStateAdvisory[] = [
			{
				title: "Rate limit warning",
				appliedAt: new Date(nowMs - 30 * 60 * 1000).toISOString(), // 30m ago
			},
			{
				title: "Memory pressure alert",
				appliedAt: new Date(nowMs - 6 * 60 * 60 * 1000).toISOString(), // 6h ago
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories,
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs,
		};

		const result = renderLiveState(input);
		const text = result.lines.join("\n");

		expect(text).toContain("- [advisory] Rate limit warning — applied 30m ago");
		expect(text).toContain("- [advisory] Memory pressure alert — applied 6h ago");
	});

	// Test 6: All four subsystems composed in fixed order
	it("renders all four subsystems in fixed order: cross-thread → task → file → advisory", () => {
		const crossThreadEntries: CrossThreadDigestEntry[] = [
			{
				title: "Thread 1",
				messageCount: 10,
				lastUpdatedAt: "2026-05-23T10:00:00Z",
			},
		];
		const taskEntries: LiveStateTaskEntry[] = [
			{
				taskId: "task-1",
				taskType: "job",
				runCount: 1,
				lastRunAt: "2026-05-23T09:00:00Z",
				status: "ran",
			},
		];
		const fileEntries: LiveStateFileEntry[] = [
			{
				path: "/file.txt",
				threadTitle: "Editor",
			},
		];
		const advisories: LiveStateAdvisory[] = [
			{
				title: "Advisory 1",
				appliedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries,
			taskEntries,
			fileEntries,
			advisories,
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: Date.now(),
		};

		const result = renderLiveState(input);
		const lines = result.lines;

		// Find indices of each subsystem
		const threadLineIdx = lines.findIndex((l) => l.includes("[thread]"));
		const taskLineIdx = lines.findIndex((l) => l.includes("[task]"));
		const fileLineIdx = lines.findIndex((l) => l.includes("[file]"));
		const advisoryLineIdx = lines.findIndex((l) => l.includes("[advisory]"));

		// Verify order: thread < task < file < advisory
		expect(threadLineIdx).toBeLessThan(taskLineIdx);
		expect(taskLineIdx).toBeLessThan(fileLineIdx);
		expect(fileLineIdx).toBeLessThan(advisoryLineIdx);
	});

	// Test 7: Synthesis-backlog line raised when count > 50
	it("renders synthesis-backlog line when count is 75", () => {
		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: 75,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		expect(result.lines).toContain("- [synthesis-backlog] 75 uncategorized detail entries");
	});

	// Test 8: Synthesis-backlog line not raised when null
	it("does not render synthesis-backlog line when count is null", () => {
		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		const hasBacklogLine = result.lines.some((l) => l.includes("[synthesis-backlog]"));
		expect(hasBacklogLine).toBe(false);
	});

	// Test 9: Budget pressure caps each subsystem to 3
	it("caps each subsystem to 3 most-recent entries when budgetPressure is true", () => {
		const crossThreadEntries: CrossThreadDigestEntry[] = Array.from({ length: 5 }, (_, i) => ({
			title: `Thread ${i + 1}`,
			messageCount: 10 + i,
			lastUpdatedAt: `2026-05-23T${String(10 + i).padStart(2, "0")}:00:00Z`,
		}));
		const taskEntries: LiveStateTaskEntry[] = Array.from({ length: 5 }, (_, i) => ({
			taskId: `task-${i + 1}`,
			taskType: "job",
			runCount: i + 1,
			lastRunAt: `2026-05-23T${String(10 + i).padStart(2, "0")}:00:00Z`,
			status: "ran",
		}));
		const fileEntries: LiveStateFileEntry[] = Array.from({ length: 5 }, (_, i) => ({
			path: `/file-${i + 1}.txt`,
			threadTitle: `Thread ${i + 1}`,
		}));
		const advisories: LiveStateAdvisory[] = Array.from({ length: 5 }, (_, i) => ({
			title: `Advisory ${i + 1}`,
			appliedAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
		}));

		const input: LiveStateInput = {
			crossThreadEntries,
			taskEntries,
			fileEntries,
			advisories,
			synthesisBacklogCount: null,
			budgetPressure: true,
			nowMs: Date.now(),
		};

		const result = renderLiveState(input);
		const lines = result.lines;

		const threadLines = lines.filter((l) => l.includes("[thread]"));
		const taskLines = lines.filter((l) => l.includes("[task]"));
		const fileLines = lines.filter((l) => l.includes("[file]"));
		const advisoryLines = lines.filter((l) => l.includes("[advisory]"));

		expect(threadLines).toHaveLength(3);
		expect(taskLines).toHaveLength(3);
		expect(fileLines).toHaveLength(3);
		expect(advisoryLines).toHaveLength(3);
	});

	// Test 10: Budget pressure does not affect synthesis-backlog line
	it("renders synthesis-backlog line even with budgetPressure true", () => {
		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: 100,
			budgetPressure: true,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		const lines = result.lines;
		const backlogLine = lines.find((l) => l.includes("[synthesis-backlog]"));

		expect(backlogLine).toBe("- [synthesis-backlog] 100 uncategorized detail entries");
	});

	// Test 11: Header and footer literals exact
	it("renders exact header and footer literals per R-VC2 and R-VC6", () => {
		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories: [],
			synthesisBacklogCount: null,
			budgetPressure: false,
			nowMs: 1000000,
		};

		const result = renderLiveState(input);
		const lines = result.lines;

		expect(lines[0]).toBe("## Live State — pointers to canonical sources");
		expect(lines[lines.length - 1]).toBe(
			"Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.",
		);
	});

	// Test 12: Source-label distinction between [advisory] and [synthesis-backlog]
	it("renders both [advisory] and [synthesis-backlog] labels distinctly", () => {
		const nowMs = Date.now();
		const advisories: LiveStateAdvisory[] = [
			{
				title: "Test Advisory",
				appliedAt: new Date(nowMs - 30 * 60 * 1000).toISOString(),
			},
		];

		const input: LiveStateInput = {
			crossThreadEntries: [],
			taskEntries: [],
			fileEntries: [],
			advisories,
			synthesisBacklogCount: 60,
			budgetPressure: false,
			nowMs,
		};

		const result = renderLiveState(input);
		const lines = result.lines;
		const text = result.lines.join("\n");

		// Verify both labels are present
		expect(text).toContain("[advisory]");
		expect(text).toContain("[synthesis-backlog]");

		// Verify they are distinct lines
		const advisoryLine = lines.find((l) => l.includes("[advisory]"));
		const backlogLine = lines.find((l) => l.includes("[synthesis-backlog]"));

		expect(advisoryLine).toBeDefined();
		expect(backlogLine).toBeDefined();
		expect(advisoryLine).not.toEqual(backlogLine);
	});
});
