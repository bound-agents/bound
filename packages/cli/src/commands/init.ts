// Task 2: bound init command
// Will implement interactive config generation

export interface InitArgs {
	ollama?: boolean;
	anthropic?: boolean;
	bedrock?: boolean;
	region?: string;
	name?: string;
	withSync?: boolean;
	withMcp?: boolean;
	withOverlay?: boolean;
	force?: boolean;
}

export async function runInit(args: InitArgs): Promise<void> {
	// Placeholder implementation
	throw new Error("runInit not yet implemented");
}
