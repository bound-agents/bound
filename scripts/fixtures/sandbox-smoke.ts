/**
 * Standalone smoke driver for the sandbox runtime.
 *
 * This entrypoint exists so we can test the sandbox's python3 and js-exec
 * commands after `bun build --compile`, without spinning up the full
 * bound agent server. It's a build-time fixture only — not shipped to
 * end users, not registered in any CLI. The build target is produced
 * ad-hoc by scripts/test-sandbox-compiled.ts, which is this file's sole
 * consumer.
 */

import { createClusterFs, createSandbox } from "../../packages/sandbox/src";

async function main() {
	// biome-ignore lint/suspicious/noExplicitAny: testing multiple overloads
	const fsObj = createClusterFs({ hostName: "smoke", syncEnabled: false }) as any;
	const clusterFs = fsObj.fs ?? fsObj;

	const sandbox = await createSandbox({
		clusterFs,
		commands: [],
	});

	const checks: Array<{ name: string; cmd: string; expect: string }> = [
		{ name: "python3", cmd: `python3 -c "print(2+2)"`, expect: "4\n" },
		{ name: "js-exec", cmd: `js-exec -c "console.log(6*7)"`, expect: "42\n" },
	];

	let allOk = true;
	for (const c of checks) {
		process.stdout.write(`[${c.name}] `);
		try {
			const r = await sandbox.bash.exec(c.cmd);
			const ok = r.stdout === c.expect && r.exitCode === 0;
			if (ok) {
				process.stdout.write("OK\n");
			} else {
				allOk = false;
				process.stdout.write(
					`FAIL: exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}\n`,
				);
			}
		} catch (e) {
			allOk = false;
			process.stdout.write(`THROWN: ${(e as Error).message}\n`);
		}
	}
	process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
	console.error("smoke fatal:", e);
	process.exit(2);
});
