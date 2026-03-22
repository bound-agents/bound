import { describe, expect, test } from "bun:test";
import { createClusterFs, diffWorkspaceAsync, snapshotWorkspace } from "../cluster-fs";

describe("ClusterFs", () => {
	test("creates a ClusterFs with proper mount structure", () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		expect(clusterFs).toBeDefined();
	});

	test("allows writing and reading files from /home/user/", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const testContent = "Hello, world!";
		await clusterFs.writeFile("/home/user/test.txt", testContent);
		const read = await clusterFs.readFile("/home/user/test.txt");
		expect(read).toBe(testContent);
	});

	test("snapshotWorkspace captures file hashes before execution", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file1.txt", "content1");
		await clusterFs.writeFile("/home/user/file2.txt", "content2");

		const snapshot = await snapshotWorkspace(clusterFs);
		expect(snapshot.size).toBe(2);
		expect(snapshot.get("/home/user/file1.txt")).toBeDefined();
		expect(snapshot.get("/home/user/file2.txt")).toBeDefined();
	});

	test("diffWorkspace detects created files", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const before = await snapshotWorkspace(clusterFs);

		await clusterFs.writeFile("/home/user/new.txt", "new content");

		const after = await snapshotWorkspace(clusterFs);
		const changes = await diffWorkspaceAsync(before, after, clusterFs);

		expect(changes.length).toBeGreaterThan(0);
		const created = changes.find((c) => c.path === "/home/user/new.txt");
		expect(created).toBeDefined();
		expect(created?.operation).toBe("created");
		expect(created?.content).toBe("new content");
	});

	test("diffWorkspace detects modified files", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "original");
		const before = await snapshotWorkspace(clusterFs);

		await clusterFs.writeFile("/home/user/file.txt", "modified");

		const after = await snapshotWorkspace(clusterFs);
		const changes = await diffWorkspaceAsync(before, after, clusterFs);

		const modified = changes.find((c) => c.path === "/home/user/file.txt");
		expect(modified).toBeDefined();
		expect(modified?.operation).toBe("modified");
		expect(modified?.content).toBe("modified");
	});

	test("diffWorkspace detects deleted files", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "content");
		const before = await snapshotWorkspace(clusterFs);

		await clusterFs.rm("/home/user/file.txt");

		const after = await snapshotWorkspace(clusterFs);
		const changes = await diffWorkspaceAsync(before, after, clusterFs);

		const deleted = changes.find((c) => c.path === "/home/user/file.txt");
		expect(deleted).toBeDefined();
		expect(deleted?.operation).toBe("deleted");
	});

	test("diffWorkspace returns empty array when no changes", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "content");
		const before = await snapshotWorkspace(clusterFs);
		const after = await snapshotWorkspace(clusterFs);

		const changes = await diffWorkspaceAsync(before, after);
		expect(changes.length).toBe(0);
	});

	test("includes file size in diff output", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "12345");
		const after = await snapshotWorkspace(clusterFs);

		const changes = await diffWorkspaceAsync(new Map(), after, clusterFs);
		const change = changes.find((c) => c.path === "/home/user/file.txt");

		expect(change?.sizeBytes).toBe(5);
	});
});
