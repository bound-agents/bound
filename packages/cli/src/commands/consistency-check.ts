export interface ConsistencyCheckArgs {
	spokeUrl?: string;
	tables?: string;
	verbose?: boolean;
}

export async function runConsistencyCheck(args: ConsistencyCheckArgs): Promise<void> {
	const spokeUrl = args.spokeUrl || "http://localhost:3001";
	const tableFilter = args.tables ? args.tables.split(",").map((t) => t.trim()) : [];

	console.log("Running consistency check...\n");

	let response: Response;
	try {
		response = await fetch(`${spokeUrl}/api/status/consistency`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tables: tableFilter }),
		});
	} catch {
		console.error(`Cannot reach spoke at ${spokeUrl}. Is it running?`);
		process.exit(1);
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: "Unknown error" }));
		console.error(
			`Consistency check failed: ${(error as { error?: string; details?: string }).details || (error as { error?: string }).error}`,
		);
		process.exit(1);
	}

	const result = (await response.json()) as {
		localSiteId: string;
		tables: Array<{
			table: string;
			localCount: number;
			remoteCount: number;
			localOnly: string[];
			remoteOnly: string[];
			matching: number;
		}>;
		unsyncable?: Array<{ table: string; count: number; reason: string }>;
	};

	console.log(`Local site: ${result.localSiteId}\n`);

	// Print table
	const header = "Table            Local  Remote  Local-only  Remote-only  Status";
	const separator = "─".repeat(header.length);
	console.log(header);
	console.log(separator);

	let totalLocalOnly = 0;
	let totalRemoteOnly = 0;
	let driftCount = 0;

	for (const t of result.tables) {
		const status = t.localOnly.length === 0 && t.remoteOnly.length === 0 ? "OK" : "DRIFT";
		if (status === "DRIFT") driftCount++;
		totalLocalOnly += t.localOnly.length;
		totalRemoteOnly += t.remoteOnly.length;

		const tableName = t.table.padEnd(16);
		const local = String(t.localCount).padStart(6);
		const remote = String(t.remoteCount).padStart(7);
		const lo = String(t.localOnly.length).padStart(11);
		const ro = String(t.remoteOnly.length).padStart(12);

		console.log(`${tableName} ${local} ${remote} ${lo} ${ro}  ${status}`);

		if (args.verbose && t.localOnly.length > 0) {
			const sample = t.localOnly.slice(0, 10);
			for (const pk of sample) {
				console.log(`  + ${pk}`);
			}
			if (t.localOnly.length > 10) {
				console.log(`  ... and ${t.localOnly.length - 10} more`);
			}
		}
		if (args.verbose && t.remoteOnly.length > 0) {
			const sample = t.remoteOnly.slice(0, 10);
			for (const pk of sample) {
				console.log(`  - ${pk}`);
			}
			if (t.remoteOnly.length > 10) {
				console.log(`  ... and ${t.remoteOnly.length - 10} more`);
			}
		}
	}

	console.log();
	if (driftCount === 0) {
		console.log("All tables are consistent.");
	} else {
		console.log(
			`${driftCount} table(s) with discrepancies (${totalLocalOnly} local-only, ${totalRemoteOnly} remote-only)`,
		);
	}

	if (result.unsyncable && result.unsyncable.length > 0) {
		console.log();
		console.log("Unsyncable rows (excluded from comparison):");
		for (const u of result.unsyncable) {
			console.log(`  ${u.table}: ${u.count} rows — ${u.reason}`);
		}
	}
}
