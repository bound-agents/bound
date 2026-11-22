/**
 * Kill a spawned command together with everything it started.
 *
 * Signalling only the direct child is not enough on POSIX hosts: a shell's
 * descendants can sit in other process groups, and survivors that ignore
 * SIGHUP (a node started by a test installs a SIGHUP hot-reload handler)
 * outlive the tool call indefinitely. The unsandboxed bash path depends on
 * this killer entirely. On the mxc path, 1.1.0's native `MxcProcess.kill()`
 * already reaps the sandbox's tree; this killer runs first as a host-side
 * fallback (under mxc 0.7.0 a sandboxed process could only signal itself, so
 * this was the only reaper).
 *
 * The killer walks the host process table from the root pid, collects every
 * descendant and every process group they lead or belong to, and signals each
 * group and each pid. Groups are remembered across calls, so the SIGKILL that
 * follows a SIGTERM still reaches descendants that were reparented to init
 * after the wrapper died (they keep their process group).
 */

export interface ProcessEntry {
	pid: number;
	ppid: number;
	pgid: number;
}

export interface TreeKillDeps {
	/** Snapshot of the host process table, or null when it can't be read. */
	readTable: () => ProcessEntry[] | null;
	kill: (pid: number, signal: NodeJS.Signals | number) => void;
	selfPid: number;
}

/** Parse `ps -A -o pid=,ppid=,pgid=` output. Malformed lines are skipped. */
export function parseProcessTable(text: string): ProcessEntry[] {
	const out: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3) continue;
		const [pid, ppid, pgid] = parts.map((p) => Number.parseInt(p, 10));
		if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
		out.push({ pid, ppid, pgid });
	}
	return out;
}

/** Read the host process table with `ps`; null on Windows or when `ps` fails. */
export function readHostProcessTable(): ProcessEntry[] | null {
	if (process.platform === "win32") return null;
	try {
		const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid="], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return null;
		return parseProcessTable(result.stdout.toString());
	} catch {
		return null;
	}
}

/**
 * Every descendant of `rootPid` (root included) and the process groups they
 * belong to, excluding the caller's own group and groups 0/1.
 */
export function collectTree(
	table: ProcessEntry[],
	rootPid: number,
	selfPid: number,
): { pids: number[]; pgids: number[] } {
	const children = new Map<number, number[]>();
	for (const e of table) {
		const list = children.get(e.ppid);
		if (list) list.push(e.pid);
		else children.set(e.ppid, [e.pid]);
	}
	const byPid = new Map(table.map((e) => [e.pid, e]));
	const ownPgid = byPid.get(selfPid)?.pgid;
	const pids: number[] = [];
	const seen = new Set<number>();
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.shift() as number;
		if (seen.has(pid)) continue;
		seen.add(pid);
		if (byPid.has(pid)) pids.push(pid);
		for (const c of children.get(pid) ?? []) queue.push(c);
	}
	const pgids = new Set<number>();
	for (const pid of pids) {
		const pgid = byPid.get(pid)?.pgid;
		if (pgid !== undefined && pgid > 1 && pgid !== ownPgid) pgids.add(pgid);
	}
	return { pids: pids.filter((p) => p !== selfPid), pgids: [...pgids] };
}

/**
 * Returns a `kill(signal)` for the tree rooted at `rootPid`. Each call takes a
 * fresh snapshot, unions it with every group seen before, and signals the
 * groups first, then the individual pids. When the process table is
 * unreadable it falls back to signalling the root alone.
 */
export function createTreeKiller(
	rootPid: number,
	deps: TreeKillDeps = {
		readTable: readHostProcessTable,
		kill: (pid, signal) => process.kill(pid, signal),
		selfPid: process.pid,
	},
): (signal?: NodeJS.Signals | number) => void {
	// pid -> pgid as first observed. A remembered pid or group is only signalled
	// again while the fresh table still shows it with that same group, so a pid
	// recycled by an unrelated process between SIGTERM and SIGKILL is left alone.
	const known = new Map<number, number>();
	return (signal = "SIGTERM") => {
		const table = deps.readTable();
		const attempt = (target: number) => {
			try {
				deps.kill(target, signal);
			} catch {
				// Already gone, or not ours to signal.
			}
		};
		if (!table) {
			attempt(rootPid);
			return;
		}
		const byPid = new Map(table.map((e) => [e.pid, e]));
		const { pids } = collectTree(table, rootPid, deps.selfPid);
		for (const pid of pids) {
			const pgid = byPid.get(pid)?.pgid;
			if (pgid !== undefined && !known.has(pid)) known.set(pid, pgid);
		}
		const ownPgid = byPid.get(deps.selfPid)?.pgid;
		const live = [...known].filter(([pid, pgid]) => byPid.get(pid)?.pgid === pgid);
		const groups = new Set<number>();
		for (const [, pgid] of known) {
			if (pgid <= 1 || pgid === ownPgid) continue;
			if (table.some((e) => e.pgid === pgid)) groups.add(pgid);
		}
		for (const g of groups) attempt(-g);
		for (const [pid] of live) if (pid !== deps.selfPid) attempt(pid);
		if (!known.has(rootPid)) attempt(rootPid);
	};
}
