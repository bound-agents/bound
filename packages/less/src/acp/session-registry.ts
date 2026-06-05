import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LocalSessionRecord {
	sessionId: string;
	cwd: string;
	updatedAt: string;
}

interface RegistryFile {
	version: 1;
	sessions: LocalSessionRecord[];
}

function registryPath(configDir: string): string {
	return join(configDir, "local-sessions.json");
}

function readRegistry(configDir: string): RegistryFile {
	try {
		const parsed = JSON.parse(readFileSync(registryPath(configDir), "utf-8")) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			parsed.version === 1 &&
			"sessions" in parsed &&
			Array.isArray(parsed.sessions)
		) {
			return {
				version: 1,
				sessions: parsed.sessions.filter(isSessionRecord),
			};
		}
	} catch {
		// Missing or malformed local metadata should not break ACP startup.
	}
	return { version: 1, sessions: [] };
}

function writeRegistry(configDir: string, registry: RegistryFile): void {
	const path = registryPath(configDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(registry, null, "\t")}\n`, "utf-8");
	renameSync(tmpPath, path);
}

function isSessionRecord(value: unknown): value is LocalSessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<LocalSessionRecord>;
	return (
		typeof record.sessionId === "string" &&
		record.sessionId.length > 0 &&
		typeof record.cwd === "string" &&
		record.cwd.length > 0 &&
		typeof record.updatedAt === "string" &&
		record.updatedAt.length > 0
	);
}

export function rememberLocalSession(configDir: string, sessionId: string, cwd: string): void {
	const registry = readRegistry(configDir);
	const nextRecord: LocalSessionRecord = {
		sessionId,
		cwd,
		updatedAt: new Date().toISOString(),
	};
	const sessions = registry.sessions.filter((record) => record.sessionId !== sessionId);
	sessions.push(nextRecord);
	writeRegistry(configDir, { version: 1, sessions });
}

export function listRememberedLocalSessions(configDir: string): LocalSessionRecord[] {
	return readRegistry(configDir).sessions;
}
