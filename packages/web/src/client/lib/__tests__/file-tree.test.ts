import { describe, expect, it } from "bun:test";
import { buildFileTree, findNodeByPath } from "../file-tree";
import type { FileMetadata } from "../file-tree";

describe("buildFileTree", () => {
	it("returns empty array for empty input", () => {
		const result = buildFileTree([]);
		expect(result).toEqual([]);
	});

	it("handles single file at root level", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const result = buildFileTree(files);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("file.txt");
		expect(result[0].type).toBe("file");
		expect(result[0].fullPath).toBe("file.txt");
		expect(result[0].children).toEqual([]);
		expect(result[0].file).toEqual(files[0]);
	});

	it("handles files in nested directories", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "dir/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const result = buildFileTree(files);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("dir");
		expect(result[0].type).toBe("dir");
		expect(result[0].children).toHaveLength(1);
		expect(result[0].children[0].name).toBe("file.txt");
		expect(result[0].children[0].type).toBe("file");
	});

	it("sorts directories before files at same level", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "zebra.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
			{
				id: "2",
				path: "apple/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const result = buildFileTree(files);
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe("dir");
		expect(result[0].name).toBe("apple");
		expect(result[1].type).toBe("file");
		expect(result[1].name).toBe("zebra.txt");
	});

	it("sorts alphabetically within same type", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "zebra/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
			{
				id: "2",
				path: "apple/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
			{
				id: "3",
				path: "banana/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const result = buildFileTree(files);
		expect(result).toHaveLength(3);
		expect(result[0].name).toBe("apple");
		expect(result[1].name).toBe("banana");
		expect(result[2].name).toBe("zebra");
	});

	it("does not create duplicate directory nodes", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "dir/file1.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
			{
				id: "2",
				path: "dir/file2.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const result = buildFileTree(files);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("dir");
		expect(result[0].children).toHaveLength(2);
		expect(result[0].children[0].name).toBe("file1.txt");
		expect(result[0].children[1].name).toBe("file2.txt");
	});

	it("handles deeply nested paths", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "a/b/c/d/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const result = buildFileTree(files);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("a");
		expect(result[0].children).toHaveLength(1);
		expect(result[0].children[0].name).toBe("b");
		expect(result[0].children[0].children).toHaveLength(1);
		expect(result[0].children[0].children[0].name).toBe("c");
		expect(result[0].children[0].children[0].children).toHaveLength(1);
		expect(result[0].children[0].children[0].children[0].name).toBe("d");
		expect(result[0].children[0].children[0].children[0].children).toHaveLength(1);
		expect(result[0].children[0].children[0].children[0].children[0].name).toBe("file.txt");
	});
});

describe("findNodeByPath", () => {
	it("returns null for empty tree", () => {
		const result = findNodeByPath([], "anything");
		expect(result).toBeNull();
	});

	it("returns null for non-existent path", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "dir/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const tree = buildFileTree(files);
		const result = findNodeByPath(tree, "nonexistent");
		expect(result).toBeNull();
	});

	it("finds a top-level directory", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "dir/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const tree = buildFileTree(files);
		const result = findNodeByPath(tree, "dir");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("dir");
		expect(result?.type).toBe("dir");
	});

	it("finds a nested directory", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "a/b/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const tree = buildFileTree(files);
		const result = findNodeByPath(tree, "a/b");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("b");
		expect(result?.type).toBe("dir");
	});

	it("finds a file node", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "dir/file.txt",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const tree = buildFileTree(files);
		const result = findNodeByPath(tree, "dir/file.txt");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("file.txt");
		expect(result?.type).toBe("file");
		expect(result?.file?.path).toBe("dir/file.txt");
	});

	it("returns null for partial path match", () => {
		const files: FileMetadata[] = [
			{
				id: "1",
				path: "src/index.ts",
				is_binary: 0,
				size_bytes: 100,
				created_at: "2026-01-01T00:00:00Z",
				modified_at: "2026-01-01T00:00:00Z",
				deleted: 0,
				created_by: "user1",
				host_origin: "local",
			},
		];
		const tree = buildFileTree(files);
		const result = findNodeByPath(tree, "sr");
		expect(result).toBeNull();
	});
});
