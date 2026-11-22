/**
 * Isolated sandbox-native-addon probe for release-image smoke tests — the mxc
 * analogue of `tree-sitter-native-probe.ts`. Compiled with `bun build --compile`
 * (and the same node-pty stub as boundless), it proves that the koffi native
 * addon and the embedded `libmxc_ffi.dylib`/`.so` both load and that the SDK
 * can create a real seatbelt/bubblewrap containment from inside a compiled
 * binary with NO node_modules on disk.
 *
 * It calls `checkSandboxAvailable()` (which materializes the embedded FFI
 * library via `ensureMxcRuntime` and runs a live no-op spawn through mxc) and
 * then runs one write-allowed and one write-denied command through the real
 * `spawnSandboxed()` path. Exit 0 = sandbox enforced; non-zero = a native
 * addon or the FFI library failed to load/enforce.
 *
 * This file is NOT a test and NOT imported by the product; it exists purely so
 * the compiled-binary sandbox path has a scriptable, node_modules-free check.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSandboxAvailable, spawnSandboxed } from "../packages/less/src/tools/sandbox";
import type { ResolvedSandboxConfig } from "../packages/less/src/tools/sandbox-policy";

async function drain(proc: { exited: Promise<number> }): Promise<number> {
	return proc.exited;
}

async function main(): Promise<void> {
	const availability = await checkSandboxAvailable();
	console.log("checkSandboxAvailable:", JSON.stringify(availability));
	if (!availability.supported) {
		throw new Error(`mxc sandbox unavailable in the compiled binary: ${availability.reason}`);
	}

	const cfg: ResolvedSandboxConfig = {
		enabled: true,
		writablePaths: [],
		network: "open",
		onUnavailable: "error",
	};

	// 1. write INSIDE the writable set (tmpdir) — must succeed.
	const allowed = join(tmpdir(), `mxc-probe-allow-${randomBytes(4).toString("hex")}.txt`);
	try {
		const proc = await spawnSandboxed(`echo ok > "${allowed}"`, process.cwd(), cfg);
		const code = await drain(proc);
		if (code !== 0) throw new Error(`write-allowed command exited ${code}`);
		if (readFileSync(allowed, "utf8").trim() !== "ok") {
			throw new Error("write-allowed command did not write the file");
		}
		console.log("write-allowed: OK");
	} finally {
		rmSync(allowed, { force: true });
	}

	// 2. write OUTSIDE the writable set (home dir) — must be denied.
	const denied = join(
		process.env.HOME ?? "/root",
		`.mxc-probe-deny-${randomBytes(4).toString("hex")}`,
	);
	const proc = await spawnSandboxed(`echo nope > "${denied}"`, process.cwd(), cfg);
	const code = await drain(proc);
	if (code === 0 || existsSync(denied)) {
		rmSync(denied, { force: true });
		throw new Error("write-denied command was NOT blocked by the sandbox");
	}
	console.log("write-denied: OK (blocked)");

	// 3. stdout must stream back and /dev/null must be writable. mxc 1.1.0's
	// Socket-wrapped pipes delivered nothing under Bun, and its seatbelt profile
	// denies /dev/null; both broke every command while exit codes stayed 0.
	const io = await spawnSandboxed(
		"echo probe-out; echo x > /dev/null && echo null-ok",
		process.cwd(),
		cfg,
	);
	const [ioOut, ioCode] = await Promise.all([
		io.stdout ? new Response(io.stdout).text() : Promise.resolve(""),
		io.exited,
	]);
	if (ioCode !== 0 || !ioOut.includes("probe-out") || !ioOut.includes("null-ok")) {
		throw new Error(`stdout/dev-null check failed: exit=${ioCode} stdout=${JSON.stringify(ioOut)}`);
	}
	console.log("stdout + /dev/null: OK");

	console.log("mxc sandbox enforced from the compiled binary (koffi + libmxc_ffi loaded)");
}

main().catch((err) => {
	console.error("mxc-sandbox-probe FAILED:", err instanceof Error ? err.message : String(err));
	process.exit(1);
});
