import { describe, expect, test } from "bun:test";

import { createClusterFs } from "../cluster-fs";
import { type SandboxConfig, createSandbox } from "../sandbox-factory";

describe("Sandbox Factory", () => {
	test("creates a Bash instance with ClusterFs", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
		};

		const sandbox = await createSandbox(config);
		expect(sandbox).toBeDefined();
	});

	test("executes simple echo command and returns output", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
		};

		const sandbox = await createSandbox(config);
		const result = await sandbox.exec("echo hello");

		expect(result.stdout).toContain("hello");
		expect(result.exitCode).toBe(0);
	});

	test("executes command with pipes correctly", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
		};

		const sandbox = await createSandbox(config);
		const result = await sandbox.exec("echo 'hello world' | grep world");

		expect(result.stdout).toContain("world");
		expect(result.exitCode).toBe(0);
	});

	test("accepts network configuration", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
			networkConfig: {
				allowedUrls: [
					{
						urlPattern: "https://example.com",
						methods: ["GET"],
					},
				],
			},
		};

		const sandbox = await createSandbox(config);
		expect(sandbox).toBeDefined();
	});

	test("applies execution limits", async () => {
		const config: SandboxConfig = {
			clusterFs: createClusterFs({ hostName: "localhost", syncEnabled: true }),
			commands: [],
			executionLimits: {
				maxCallDepth: 100,
				maxCommandCount: 5000,
				maxLoopIterations: 5000,
			},
		};

		const sandbox = await createSandbox(config);
		expect(sandbox).toBeDefined();
	});
});
