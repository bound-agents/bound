import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSiteId, insertRow, updateRow } from "@bound/core";
import { MAX_PERSONA_BYTES, PERSONA_CLUSTER_CONFIG_KEY } from "@bound/shared";
import { openBoundDB } from "../lib/db";

export interface SetPersonaArgs {
	/** Path to a file to read the persona from. When omitted, stdin is read. */
	file?: string;
	configDir?: string;
}

/**
 * Set the cluster-wide operator persona (`cluster_config['persona']`).
 *
 * The persona is a single synced LWW row, so the edit propagates to every host
 * — including hosts that assemble relayed turns. It is read live at
 * context-assembly time (no cache), so the change takes effect on the next turn
 * cluster-wide without a reload signal. Source is a file argument or stdin.
 */
export async function runSetPersona(args: SetPersonaArgs): Promise<void> {
	const configDir = args.configDir || "config";
	// Data directory is the sibling `data` of the config directory.
	const dataDir = join(dirname(resolve(configDir)), "data");

	// Read the new persona from a file or stdin.
	let content: string;
	if (args.file) {
		const personaPath = resolve(args.file);
		try {
			content = readFileSync(personaPath, "utf-8");
		} catch (error) {
			throw new Error(
				`Failed to read ${personaPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else {
		content = await Bun.stdin.text();
	}

	if (content.length === 0) {
		throw new Error(
			"Refusing to set an empty persona. Pass a file with --file, or pipe non-empty content on stdin.",
		);
	}

	const byteLength = Buffer.byteLength(content, "utf-8");
	if (byteLength > MAX_PERSONA_BYTES) {
		throw new Error(
			`Persona is ${byteLength} bytes, over the ${MAX_PERSONA_BYTES}-byte cap. Trim it before setting.`,
		);
	}

	const db = openBoundDB(dataDir);
	try {
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}

		const existing = db
			.query("SELECT key FROM cluster_config WHERE key = ?")
			.get(PERSONA_CLUSTER_CONFIG_KEY);

		if (existing) {
			updateRow(db, "cluster_config", PERSONA_CLUSTER_CONFIG_KEY, { value: content }, siteId);
		} else {
			insertRow(
				db,
				"cluster_config",
				{
					key: PERSONA_CLUSTER_CONFIG_KEY,
					value: content,
					modified_at: new Date().toISOString(),
				},
				siteId,
			);
		}

		console.log(`Persona set (${byteLength} bytes). It will propagate to all hosts on next sync.`);
	} finally {
		db.close();
	}
}
