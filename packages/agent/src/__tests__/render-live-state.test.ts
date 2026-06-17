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
			'<live-state sources="Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.">',
			"</live-state>",
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
			'<thread title="Project Alpha" messages="42" updated="2026-05-23T10:30:00Z" local="false"/>',
		);
		expect(lines).toContain(
			'<thread title="Project Beta" messages="15" updated="2026-05-23T09:00:00Z" local="false"/>',
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

		// Live session: thread carries a <session> child with live="true".
		expect(lines).toContain(
			'<thread title="On Mac" messages="7" updated="2026-05-23T10:30:00Z" local="false">',
		);
		expect(lines).toContain('<session host="mac-studio" live="true" local="false"/>');
		// Stale session: same shape, live="false" so it isn't mistaken for live.
		expect(lines).toContain(
			'<thread title="Stale Elsewhere" messages="3" updated="2026-05-23T09:00:00Z" local="false">',
		);
		expect(lines).toContain('<session host="old-laptop" live="false" local="false"/>');
		// No session: self-closing thread element, no children.
		expect(lines).toContain(
			'<thread title="No Session" messages="1" updated="2026-05-23T08:00:00Z" local="false"/>',
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
			'<task id="task-001" type="scheduled" runs="5" last-run="2026-05-23T08:00:00Z" status="ran"/>',
		);
		expect(lines).toContain(
			'<task id="task-002" type="cron" runs="2" last-run="2026-05-23T07:30:00Z" status="failed"/>',
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

		// `local` reflects f.isLocal (file's owning host == assembling host).
		// `host` rides as an attribute; remote-ness is the local="false" flag,
		// not a textual `, remote` marker.
		expect(lines).toContain(
			'<file path="/home/user/docs/report.md" thread="Documentation Review" host="7cf34dd659c0" local="true"/>',
		);
		expect(lines).toContain(
			'<file path="/home/user/code/app.ts" thread="Feature Development" host="MSI" local="false"/>',
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
			'<file path="/home/user/orphan.md" thread="Orphaned Thread" local="false"/>',
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

		expect(text).toContain('<advisory title="Rate limit warning" applied="30m ago"/>');
		expect(text).toContain('<advisory title="Memory pressure alert" applied="6h ago"/>');
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
		const threadLineIdx = lines.findIndex((l) => l.includes("<thread "));
		const taskLineIdx = lines.findIndex((l) => l.includes("<task "));
		const fileLineIdx = lines.findIndex((l) => l.includes("<file "));
		const advisoryLineIdx = lines.findIndex((l) => l.includes("<advisory "));

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
		expect(result.lines).toContain('<synthesis-backlog count="75"/>');
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

		const threadLines = lines.filter((l) => l.includes("<thread "));
		const taskLines = lines.filter((l) => l.includes("<task "));
		const fileLines = lines.filter((l) => l.includes("<file "));
		const advisoryLines = lines.filter((l) => l.includes("<advisory "));

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
		const backlogLine = lines.find((l) => l.includes("<synthesis-backlog "));

		expect(backlogLine).toBe('<synthesis-backlog count="100"/>');
	});

	// Test 11: <live-state> wrapper opens with sources attribute and closes
	it("wraps subsystems in a <live-state> element carrying the sources attribute", () => {
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

		expect(lines[0]).toBe(
			'<live-state sources="Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.">',
		);
		expect(lines[lines.length - 1]).toBe("</live-state>");
	});

	// Test 12: Source-label distinction between advisory and synthesis-backlog
	it("renders both advisory and synthesis-backlog elements distinctly", () => {
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

		// Verify both element tags are present
		expect(text).toContain("<advisory ");
		expect(text).toContain("<synthesis-backlog ");

		// Verify they are distinct lines
		const advisoryLine = lines.find((l) => l.includes("<advisory "));
		const backlogLine = lines.find((l) => l.includes("<synthesis-backlog "));

		expect(advisoryLine).toBeDefined();
		expect(backlogLine).toBeDefined();
		expect(advisoryLine).not.toEqual(backlogLine);
	});
});
