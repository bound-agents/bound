import { describe, expect, test } from "bun:test";

import { createClusterFs } from "../cluster-fs";
import { type SandboxConfig, createSandbox } from "../sandbox-factory";

describe("Sandbox Factory", () => {
	test("executes simple echo command and returns output", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
		};

		const sandbox = await createSandbox(config);
		const result = await sandbox.bash.exec("echo hello");

		expect(result.stdout).toContain("hello");
		expect(result.exitCode).toBe(0);
	});

	test("executes command with pipes correctly", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
		};

		const sandbox = await createSandbox(config);
		const result = await sandbox.bash.exec("echo 'hello world' | grep world");

		expect(result.stdout).toContain("world");
		expect(result.exitCode).toBe(0);
	});

	test("checkMemoryThreshold returns correct initial state", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
			memoryThresholdBytes: 1024,
		};

		const sandbox = await createSandbox(config);
		const result = sandbox.checkMemoryThreshold();

		expect(result.overThreshold).toBe(false);
		expect(result.usageBytes).toBe(0);
		expect(result.thresholdBytes).toBe(1024);
	});

	test("memory tracker updates on file writes via sandbox", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const config: SandboxConfig = {
			clusterFs: fs,
			commands: [],
			memoryThresholdBytes: 100,
		};

		const sandbox = await createSandbox(config);

		// Write file through the filesystem (which is tracked)
		await fs.writeFile("/home/user/test.txt", "hello world");
		const result = sandbox.checkMemoryThreshold();

		expect(result.usageBytes).toBe(Buffer.byteLength("hello world"));
		expect(result.overThreshold).toBe(false);
	});

	test("memory tracker detects when threshold is exceeded", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const config: SandboxConfig = {
			clusterFs: fs,
			commands: [],
			memoryThresholdBytes: 10, // Very low threshold
		};

		const sandbox = await createSandbox(config);

		// Write enough data to exceed threshold
		await fs.writeFile("/home/user/test.txt", "this is more than 10 bytes");
		const result = sandbox.checkMemoryThreshold();

		expect(result.overThreshold).toBe(true);
		expect(result.usageBytes).toBeGreaterThan(10);
	});
});
