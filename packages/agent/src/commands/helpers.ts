import { formatError } from "@bound/shared";

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function commandError(message: string): CommandResult {
	return { stdout: "", stderr: `Error: ${message}\n`, exitCode: 1 };
}

export function commandSuccess(output: string): CommandResult {
	return { stdout: output, stderr: "", exitCode: 0 };
}

export function handleCommandError(error: unknown): CommandResult {
	const message = formatError(error);
	return commandError(message);
}
