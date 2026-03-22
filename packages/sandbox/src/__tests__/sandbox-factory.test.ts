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
