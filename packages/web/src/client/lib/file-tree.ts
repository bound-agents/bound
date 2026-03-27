import type { AgentFile } from "@bound/shared";

export type FileMetadata = Omit<AgentFile, "content">;

export interface FileTreeNode {
	name: string;
	fullPath: string;
	type: "file" | "dir";
	children: FileTreeNode[];
	file?: FileMetadata;
}

export function buildFileTree(files: FileMetadata[]): FileTreeNode[] {
	const rootNodes: FileTreeNode[] = [];
	const nodeMap: Map<string, FileTreeNode> = new Map();

	for (const file of files) {
		const parts = file.path.split("/").filter((p) => p.length > 0);

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const fullPath = parts.slice(0, i + 1).join("/");
			const key = fullPath;
			const isFile = i === parts.length - 1;

			if (!nodeMap.has(key)) {
				const node: FileTreeNode = {
					name: part,
					fullPath,
					type: isFile ? "file" : "dir",
					children: [],
				};

				if (isFile) {
					node.file = file;
				}

				nodeMap.set(key, node);

				if (i === 0) {
					// Root level node
					rootNodes.push(node);
				} else {
					// Add to parent's children
					const parentPath = parts.slice(0, i).join("/");
					const parent = nodeMap.get(parentPath);
					if (parent) {
						parent.children.push(node);
					}
				}
			}
		}
	}

	return sortTree(rootNodes);
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
	const dirs = nodes
		.filter((n) => n.type === "dir")
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((n) => ({
			...n,
			children: sortTree(n.children),
		}));

	const files = nodes.filter((n) => n.type === "file").sort((a, b) => a.name.localeCompare(b.name));

	return [...dirs, ...files];
}
