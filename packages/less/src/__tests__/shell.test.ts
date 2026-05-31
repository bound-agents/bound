import { describe, expect, it } from "bun:test";
import { resolveShell } from "../tools/shell";

describe("resolveShell — auto-detect (no override)", () => {
	it("defaults to POSIX sh on linux", () => {
		const r = resolveShell(undefined, { platform: "linux" });
		expect(r).toEqual({
			command: "sh",
			execFlag: "-c",
			toolName: "boundless_bash",
			label: "POSIX shell (sh)",
		});
	});

	it("defaults to POSIX sh on darwin", () => {
		const r = resolveShell(undefined, { platform: "darwin" });
		expect(r.command).toBe("sh");
		expect(r.execFlag).toBe("-c");
		expect(r.toolName).toBe("boundless_bash");
	});

	it("prefers PowerShell on win32 when pwsh is present", () => {
		const r = resolveShell(undefined, {
			platform: "win32",
			which: (c) => (c === "pwsh" ? "C:\\\\pwsh.exe" : null),
		});
		expect(r).toEqual({
			command: "C:\\\\pwsh.exe",
			execFlag: "-Command",
			toolName: "boundless_pwsh",
			label: "PowerShell",
		});
	});

	it("falls back to legacy powershell.exe on win32 when pwsh is absent", () => {
		const r = resolveShell(undefined, {
			platform: "win32",
			which: (c) => (c === "powershell.exe" ? "C:\\\\WINDOWS\\\\powershell.exe" : null),
		});
		expect(r.toolName).toBe("boundless_pwsh");
		expect(r.execFlag).toBe("-Command");
		expect(r.command).toBe("C:\\\\WINDOWS\\\\powershell.exe");
	});

	it("falls back to COMSPEC cmd.exe on win32 when no PowerShell is present", () => {
		const r = resolveShell(undefined, {
			platform: "win32",
			which: () => null,
			env: { COMSPEC: "C:\\\\WINDOWS\\\\system32\\\\cmd.exe" },
		});
		expect(r).toEqual({
			command: "C:\\\\WINDOWS\\\\system32\\\\cmd.exe",
			execFlag: "/c",
			toolName: "boundless_cmd",
			label: "Windows Command Prompt (cmd.exe)",
		});
	});

	it("falls back to bare cmd.exe on win32 when COMSPEC is unset", () => {
		const r = resolveShell(undefined, {
			platform: "win32",
			which: () => null,
			env: {},
		});
		expect(r.command).toBe("cmd.exe");
		expect(r.execFlag).toBe("/c");
		expect(r.toolName).toBe("boundless_cmd");
	});
});

describe("resolveShell — explicit override", () => {
	it("classifies a POSIX override path by basename and keeps -c semantics", () => {
		const r = resolveShell("/bin/zsh", { exists: () => true });
		expect(r).toEqual({
			command: "/bin/zsh",
			execFlag: "-c",
			toolName: "boundless_bash",
			label: "POSIX shell (zsh)",
		});
	});

	it("classifies a bare pwsh override via PATH lookup", () => {
		const r = resolveShell("pwsh", { which: (c) => (c === "pwsh" ? "/usr/bin/pwsh" : null) });
		expect(r).toEqual({
			command: "pwsh",
			execFlag: "-Command",
			toolName: "boundless_pwsh",
			label: "PowerShell",
		});
	});

	it("classifies a cmd.exe override (with .exe suffix) as cmd", () => {
		const r = resolveShell("C:\\\\WINDOWS\\\\system32\\\\cmd.exe", { exists: () => true });
		expect(r.execFlag).toBe("/c");
		expect(r.toolName).toBe("boundless_cmd");
	});

	it("classifies a powershell.exe override as pwsh", () => {
		const r = resolveShell("C:\\\\WINDOWS\\\\powershell.exe", { exists: () => true });
		expect(r.execFlag).toBe("-Command");
		expect(r.toolName).toBe("boundless_pwsh");
	});

	it("treats an empty-string override as no override (auto-detect)", () => {
		const r = resolveShell("", { platform: "linux" });
		expect(r.command).toBe("sh");
	});

	it("throws a fatal error when an override path does not exist", () => {
		expect(() => resolveShell("/nonexistent/shell", { exists: () => false })).toThrow(
			/configured shell/i,
		);
	});

	it("throws a fatal error when a bare override is not found on PATH", () => {
		expect(() => resolveShell("notashell", { which: () => null })).toThrow(/configured shell/i);
	});
});
