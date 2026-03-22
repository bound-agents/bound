// Task 4: boundctl restore command
// Will implement point-in-time recovery

export interface RestoreArgs {
	before: string;
	preview?: boolean;
	tables?: string[];
	configDir?: string;
}

export async function runRestore(args: RestoreArgs): Promise<void> {
	// Placeholder implementation
	throw new Error("runRestore not yet implemented");
}
