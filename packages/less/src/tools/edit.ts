import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { formatProvenance } from "./provenance";
import type { ToolHandler } from "./types";

export const editTool: ToolHandler = async (args, _signal, cwd) => {
	const { file_path, old_string, new_string } = args as {
		file_path?: string;
		old_string?: string;
		new_string?: string;
	};

	if (!file_path || typeof file_path !== "string") {
		return [
			formatProvenance("unknown", cwd, "boundless_edit"),
			{
				type: "text",
				text: "Error: file_path is required and must be a string",
			},
		];
	}

	if (old_string === undefined || typeof old_string !== "string") {
		return [
			formatProvenance("unknown", cwd, "boundless_edit"),
			{
				type: "text",
				text: "Error: old_string is required and must be a string",
			},
		];
	}

	if (new_string === undefined || typeof new_string !== "string") {
		return [
			formatProvenance("unknown", cwd, "boundless_edit"),
			{
				type: "text",
				text: "Error: new_string is required and must be a string",
			},
		];
	}

	const resolvedPath = isAbsolute(file_path) ? file_path : resolve(cwd, file_path);

	const provenance = formatProvenance("unknown", cwd, "boundless_edit");

	try {
		const content = readFileSync(resolvedPath, "utf-8");

		// Count occurrences of old_string
		const occurrences = content.split(old_string).length - 1;

		if (occurrences === 0) {
			return [
				provenance,
				{
					type: "text",
					text: `Error: old_string not found in ${file_path}`,
				},
			];
		}

		if (occurrences > 1) {
			// Show context for multiple matches
			const lines = content.split("\n");
			const matches: Array<{ lineNum: number; line: string }> = [];

			lines.forEach((line, idx) => {
				if (line.includes(old_string)) {
					matches.push({ lineNum: idx + 1, line });
				}
			});

			const context = matches
				.slice(0, 2)
				.map((m) => `  Line ${m.lineNum}: ${m.line}`)
				.join("\n");

			return [
				provenance,
				{
					type: "text",
					text: `Error: ${occurrences} matches found for old_string in ${file_path}. Cannot edit with multiple matches.\n\nFirst match locations:\n${context}`,
				},
			];
		}

		// Replace the single occurrence
		const newContent = content.replace(old_string, new_string);
		writeFileSync(resolvedPath, newContent, "utf-8");

		return [
			provenance,
			{
				type: "text",
				text: `Edited ${file_path}: replaced 1 occurrence`,
			},
		];
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error?.code === "ENOENT") {
			return [
				provenance,
				{
					type: "text",
					text: `Error: ENOENT: no such file or directory: ${file_path}`,
				},
			];
		}
		return [
			provenance,
			{
				type: "text",
				text: `Error: ${error?.message || String(err)}`,
			},
		];
	}
};
