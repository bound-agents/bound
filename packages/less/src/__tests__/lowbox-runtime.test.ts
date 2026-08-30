import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLowboxArgs,
	lowboxHelperSourcePath,
	materializeLowboxHelper,
	parseLowboxFailure,
	resolveLowboxHelperPath,
	spawnLowbox,
} from "../tools/lowbox-runtime";

const shell = {
	command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	execFlag: "-Command",
	toolName: "boundless_pwsh",
	label: "PowerShell",
};

const sandbox = {
	enabled: true,
	writablePaths: ["C:\\extra root"],
	network: "open" as const,
	onUnavailable: "error" as const,
};

describe("Windows bash dispatch", () => {
	it("routes enabled Windows commands only through lowbox and onUnavailable", () => {
		const source = readFileSync(join(import.meta.dir, "../tools/bash.ts"), "utf8");
		const start = source.indexOf("async function spawnForBash(");
		const end = source.indexOf("\n}\n\n/**", start);
		const dispatch = source.slice(start, end);

		expect(start).toBeGreaterThan(0);
		expect(dispatch).toContain('process.platform === "win32"');
		expect(dispatch).toContain("trySandboxedViaLowbox(");
		expect(dispatch).toContain('sandbox.onUnavailable === "passthrough"');
		expect(dispatch).toContain("ran UNSANDBOXED");
		expect(dispatch).toContain("refusing to run the command unsandboxed");
		expect(dispatch).toContain("explicit unsandboxed fallback");
		expect(dispatch).not.toContain("IsolationSession");
		expect(dispatch).not.toContain("iso-session");
	});
});

it("captures helper close before awaiting readiness", async () => {
	const { PassThrough } = await import("node:stream");
	const { EventEmitter } = await import("node:events");
	const child = new EventEmitter() as EventEmitter & {
		stdio: Array<PassThrough | null>;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: () => boolean;
	};
	const control = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdio = [null, child.stdout, child.stderr, control];
	child.kill = () => true;
	const spawn = () => {
		queueMicrotask(() => {
			child.emit("spawn");
			control.write('{"ok":true,"pid":4242}\n');
			child.emit("exit", 0);
			child.emit("close", 0);
		});
		return child;
	};
	const originalHelper = process.env.BOUND_LOWBOX_HELPER;
	process.env.BOUND_LOWBOX_HELPER = process.execPath;
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32" });
	try {
		const result = await spawnLowbox(
			"echo ok",
			process.cwd(),
			process.cwd(),
			shell,
			sandbox,
			"close-before-return-test",
			{ spawn },
		);
		expect(result.pid).toBe(4242);
		expect(await Promise.race([result.exited, Bun.sleep(100).then(() => "timeout")])).toBe(0);
	} finally {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		process.env.BOUND_LOWBOX_HELPER = originalHelper;
	}
});

describe("Windows lowbox helper materialization", () => {
	it("defines checked local authority restoration instead of only declaring it", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const signature =
			"LocalAuthorityCleanupResult restoreMaterializedAuthority(Profile& profile, AclScope& aclScope)";
		const occurrences = source.split(signature).length - 1;

		expect(occurrences).toBe(2);
		expect(source).toContain(`${signature} {`);
	});
	it("uses complete SECURITY_ATTRIBUTES types in native aggregate initializers", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");

		expect(source).not.toContain("SECURITY_ATTRIBUTES inherit{sizeof(inherit)");
		expect(source).toContain(
			"SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};",
		);
	});
	it("passes only explicitly inheritable restricted handles to the cleanup watcher", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("WatcherStartResult startCleanupWatcher(");
		const watcherEnd = source.indexOf("}  // namespace", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);

		expect(watcher).toContain("HANDLE inherited[] = {inheritedJob.value, inheritedChild.value");
		expect(watcher).toContain("TRUE, DUPLICATE_SAME_ACCESS");
		expect(watcher).toContain(
			"SetHandleInformation(controlRead.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)",
		);
		expect(watcher).toContain(
			"CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE",
		);
		expect(watcher).toContain("inheritedChild.reset()");
		expect(watcher).toContain("UpdateProcThreadAttribute(watcher handles)");
		expect(watcher).toContain("CreateProcessW(cleanup watcher)");
	});

	it("waits for the watcher report stream before closing its observational process handle", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const awaitStart = source.indexOf("WatcherTerminalStatus awaitArmedWatcherTerminalStatus(");
		const awaitEnd = source.indexOf("bool queryJobTreeEmpty", awaitStart);
		const awaitWatcher = source.slice(awaitStart, awaitEnd);

		expect(awaitWatcher.indexOf("CloseHandle(watcherControlWrite)")).toBeLessThan(
			awaitWatcher.indexOf("ReadFile(watcherReportRead"),
		);
		expect(awaitWatcher).toContain("WaitForSingleObject(cleanupWatcher, 0)");
		expect(awaitWatcher).not.toContain("GetExitCodeProcess(cleanupWatcher");
		const terminalClose = awaitWatcher.lastIndexOf("closeArmedWatcherObservationHandles()");
		expect(terminalClose).toBeGreaterThan(awaitWatcher.indexOf("ReadFile(watcherReportRead"));
		expect(awaitWatcher).not.toContain("WaitForSingleObject(child");
		expect(awaitWatcher).not.toContain("WaitForSingleObject(job");
	});

	it("retires the synchronous control pipe after EOF without treating EOF as cancellation", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);

		expect(watcher).not.toContain(
			"HANDLE lifecycleSignals[] = {childHandle, owner.value, controlRead}",
		);
		expect(watcher).toContain("PeekNamedPipe(controlRead");
		expect(watcher).toContain("controlPipeOpen = false");
		expect(watcher).not.toContain("if (controlError == ERROR_BROKEN_PIPE) continue;");
	});

	it("passes the watcher its inherited job authority handle", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("WatcherStartResult startCleanupWatcher(");
		const watcherEnd = source.indexOf("}  // namespace", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);

		expect(watcher).toContain("HANDLE inherited[] = {inheritedJob.value, inheritedChild.value");
	});

	it("returns pre-transfer authority only after the watcher stops and its journal identity is cleared", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const start = source.indexOf("auto cancelPreTransferWatcherAndObserve");
		const end = source.indexOf("auto requestArmedWatcherCancelAndObserve", start);
		const rollback = source.slice(start, end);

		expect(rollback).not.toContain("for (;;)");
		expect(rollback).not.toContain("LOWBOX_WATCHER_STOP_RECOVERY_RETRY");
		expect(rollback).toContain("TerminateProcess(watcherProcess, 125)");
		expect(rollback).toContain("resolveFailedHandoffJournal");
		expect(rollback).toContain("WatcherStartOutcome::IndeterminateWatcherOwned");
		expect(rollback).toContain("FailedHandoffResolution::OwnerAuthorityRetained");
		expect(rollback).toContain("FailedHandoffResolution::OwnerTeardownComplete");
	});

	it("scopes stale-authority recovery to the current oracle namespace", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");

		expect(source).toContain('flag == L"--test-namespace"');
		expect(source).toContain("authorityJournalPattern(namespaceValue)");
		expect(source).toContain("recoverStaleAuthority(testNamespace)");
	});

	it("preserves the exact cleanup phase and HRESULT through the watcher report pipe", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);
		const cleanupStart = source.indexOf(
			"bool cleanupRecoverableAuthorityLocked(",
			source.indexOf("void reportAuthorityCleanupFailure("),
		);
		const cleanupEnd = source.indexOf("bool recoverAuthorityJournalLocked(", cleanupStart);
		const cleanup = source.slice(cleanupStart, cleanupEnd);

		expect(cleanup).toContain("AuthorityCleanupFailure* failure");
		expect(cleanup).toContain(
			'captureAuthorityCleanupFailure(failure, L"DeleteAppContainerProfile", error, deleted)',
		);
		expect(watcher).toContain("AuthorityCleanupFailure cleanupFailure");
		expect(watcher).toContain("failWatcher(failure.operation.c_str()");
		expect(watcher).toContain("failure.hresult");
		expect(watcher).not.toContain('failWatcher(L"authority cleanup", GetLastError())');
	});

	it("reads the registered profile mapping by SID and diagnoses fatal registry probes", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const inspectStart = source.indexOf('std::wstring(argv[1]) == L"inspect-cleanup"');
		const inspectEnd = source.indexOf('std::wstring(argv[1]) == L"cleanup-watch"', inspectStart);
		const inspect = source.slice(inspectStart, inspectEnd);

		expect(inspect).not.toContain("GetAppContainerRegistryLocation");
		expect(inspect).toContain("DeriveAppContainerSidFromAppContainerName");
		expect(inspect).toContain("ConvertSidToStringSidW");
		const mappingPath = inspect.slice(
			inspect.indexOf("const std::wstring profileMappingPath"),
			inspect.indexOf("LocalFree(profileSidString)"),
		);
		expect(mappingPath).toContain(
			'L"Software\\\\Classes\\\\Local Settings\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\AppContainer\\\\Mappings\\\\"',
		);
		expect(mappingPath).toContain("std::wstring(profileSidString)");
		expect(inspect).toContain("RegOpenKeyExW(HKEY_CURRENT_USER, profileMappingPath.c_str()");
		expect(inspect).toContain("profileStatus == ERROR_SUCCESS");
		expect(inspect).toContain("profileStatus != ERROR_FILE_NOT_FOUND");
		expect(inspect).toContain("profileStatus != ERROR_PATH_NOT_FOUND");
		expect(inspect).not.toContain("const bool profileExists = SUCCEEDED(derived)");
		expect(inspect).toContain('inspectCleanupFatal(L"DeriveAppContainerSidFromAppContainerName"');
		expect(inspect).toContain('inspectCleanupFatal(L"ConvertSidToStringSidW"');
		expect(inspect).toContain('inspectCleanupFatal(L"RegOpenKeyExW(profile mapping)"');
		expect(inspect).toContain('inspectCleanupFatal(L"GetNamedSecurityInfoW"');
		const convertFailure = inspect.slice(
			inspect.indexOf("if (!ConvertSidToStringSidW"),
			inspect.indexOf("const std::wstring profileMappingPath"),
		);
		expect(convertFailure).toContain("FreeSid(profileSid)");
		const mappingFailure = inspect.slice(
			inspect.indexOf("if (!profileExists"),
			inspect.indexOf("bool lowboxAce"),
		);
		expect(mappingFailure).toContain("FreeSid(profileSid)");
		expect(inspect).toContain("LocalFree(profileSidString)");
		expect(inspect.slice(inspect.indexOf("bool lowboxAce"))).toContain("FreeSid(profileSid)");
	});

	it("validates the durable Recoverable journal before any watcher authority teardown", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);
		const recoverable = watcher.indexOf("markAuthorityJournalRecoverableLocked(");
		const readJournal = watcher.indexOf("readAuthorityJournal(journalPath, cleanup)");
		const validateJournal = watcher.indexOf(
			"validateRecoverableAuthorityJournal(journalPath, cleanup)",
		);
		const closeHandles = watcher.indexOf(
			"closeWatcherLowboxHandles(childHandle, jobHandle, reportAuthorityCleanupFailure)",
		);
		const closeFailure = watcher.indexOf("if (!closeWatcherLowboxHandles(");
		const sharedCleanup = watcher.indexOf(
			"cleanupRecoverableAuthorityLocked(journalPath, cleanup, &cleanupFailure)",
		);
		const validationFailure = watcher.slice(validateJournal, closeHandles);
		const destructiveCalls = [
			"CloseHandle(childHandle)",
			"CloseHandle(jobHandle)",
			"restoreAuthorityLines(",
			"DeleteAppContainerProfile(",
			"DeleteFileW(",
		];

		expect(recoverable).toBeGreaterThan(watcher.indexOf("waitForJobTreeDeath(jobHandle"));
		expect(watcher.indexOf("AuthorityRecoveryLock recoveryLock(journalPath)")).toBeLessThan(
			recoverable,
		);
		expect(recoverable).toBeLessThan(readJournal);
		expect(readJournal).toBeLessThan(validateJournal);
		expect(validateJournal).toBeLessThan(closeHandles);
		expect(validationFailure).toContain(
			'return failWatcher(L"validate authority journal", ERROR_INVALID_DATA);',
		);
		for (const call of destructiveCalls) {
			expect(watcher.slice(recoverable, validateJournal)).not.toContain(call);
			expect(validationFailure).not.toContain(call);
		}
		expect(closeFailure).toBeLessThan(sharedCleanup);
		expect(source).toContain(
			"bool closeWatcherLowboxHandles(HANDLE& childHandle, HANDLE& jobHandle,",
		);
		expect(source).toContain('reportFailure(L"close child handle", error, S_OK);');
		expect(source).toContain('reportFailure(L"close job handle", error, S_OK);');
	});

	it("strictly parses journal numbers into a fresh authority value", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const parserStart = source.indexOf("bool readAuthorityJournal(");
		const parserEnd = source.indexOf("bool verifyAuthorityJournal(", parserStart);
		const parser = source.slice(parserStart, parserEnd);
		const selfTestStart = source.indexOf("int selfTestAuthorityJournal()");
		const selfTestEnd = source.indexOf("int wmain(", selfTestStart);
		const selfTest = source.slice(selfTestStart, selfTestEnd);

		expect(parser).toContain("AuthorityJournal candidate;");
		expect(parser).toContain("parsed = std::move(candidate);");
		expect(parser).toContain("parseJournalDword(");
		expect(parser).toContain("parseJournalUlonglong(");
		expect(selfTest).toContain("negativeNumber");
		expect(selfTest).toContain("overflowNumber");
	});
	it("filters only inherited writable AppContainer package ACEs from protected git DACLs", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const start = source.indexOf("bool saveAndProtectGitControlSurface");
		const end = source.indexOf("bool makePipe", start);
		const protection = source.slice(start, end);
		const findHandleStart = source.indexOf("struct FindHandle");
		const findHandleEnd = source.indexOf("struct Profile", findHandleStart);
		const findHandle = source.slice(findHandleStart, findHandleEnd);

		expect(protection).toContain("GetFileAttributesW(path.c_str())");
		expect(protection).toContain("attributes & FILE_ATTRIBUTE_REPARSE_POINT");
		const hooksRootCheck = protection.indexOf("attributes & FILE_ATTRIBUTE_REPARSE_POINT");
		const descendantCollection = protection.indexOf(
			"collectExistingHookDescendants(path, descendants)",
		);
		expect(hooksRootCheck).toBeGreaterThan(-1);
		expect(descendantCollection).toBeGreaterThan(-1);
		expect(protection).toContain("FindFirstFileW");
		expect(protection).toContain("FindNextFileW");
		expect(findHandle).toContain("struct FindHandle");
		expect(findHandle).toContain("FindClose(value)");
		expect(protection).toContain("FindHandle search;");
		expect(source).not.toContain("Handle search(FindFirstFileW");
		expect(protection).toContain("FILE_ATTRIBUTE_DIRECTORY");
		expect(protection).toContain("NO_INHERITANCE");
		expect(protection).toContain("PROTECTED_DACL_SECURITY_INFORMATION");
		expect(protection).toContain("FILE_GENERIC_READ | FILE_GENERIC_EXECUTE");
		expect(protection).toContain("SUB_CONTAINERS_AND_OBJECTS_INHERIT");
		expect(protection).toContain("INHERITED_ACE");
		expect(protection).toContain("EqualSid");
		expect(protection).toContain("WinBuiltinAnyPackageSid");
		expect(protection).toContain("SECURITY_APP_PACKAGE_AUTHORITY");
		expect(protection).toContain("AllocateAndInitializeSid(&appPackageAuthority, 2, 2, 2,");
		expect(protection).not.toContain("SECURITY_CAPABILITY_BASE_RID");
		expect(protection).toContain("AllocateAndInitializeSid");
		expect(protection).toContain("ConvertSidToStringSidW");
		expect(protection).toContain('L"S-1-15-2-1"');
		expect(protection).toContain('L"S-1-15-2-2"');
		expect(protection).not.toContain("WinBuiltinAnyRestrictedPackageSid");
		expect(source).toContain("CreateWellKnownSid");
		expect(source).toContain("FILE_WRITE_DATA");
		expect(source).toContain("FILE_APPEND_DATA");
		expect(source).toContain("FILE_ADD_FILE");
		expect(source).toContain("FILE_ADD_SUBDIRECTORY");
		expect(source).toContain("FILE_DELETE_CHILD");
		expect(source).toContain("DELETE");
		expect(source).toContain("WRITE_DAC");
		expect(source).toContain("WRITE_OWNER");
		expect(source).not.toContain("WinBuiltinUsersSid");
		expect(source).not.toContain("WinWorldSid");
		expect(protection).toContain("record->dacl->AclSize");
		expect(protection).toContain("explicitReadAceCapacity");
		expect(protection).toContain("GetSecurityDescriptorControl");
		expect(protection).not.toContain('L"index"');
		expect(protection).not.toContain('L"refs"');
		expect(protection).not.toContain('L"logs"');
		expect(protection).not.toContain('L"objects"');
	});

	it("restores protected git DACL descriptors during checked cleanup", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const cleanupStart = source.indexOf(
			"LocalAuthorityCleanupResult restoreMaterializedAuthority(Profile& profile, AclScope& aclScope) {",
		);
		const cleanupEnd = source.indexOf(
			"[[noreturn]] void retryMaterializedAuthorityRecovery",
			cleanupStart,
		);
		const cleanup = source.slice(cleanupStart, cleanupEnd);

		expect(cleanup).toContain("record.daclProtected");
		expect(cleanup).toContain("PROTECTED_DACL_SECURITY_INFORMATION");
		expect(cleanup).toContain("UNPROTECTED_DACL_SECURITY_INFORMATION");
	});

	it("rejects writable roots whose existing path contains a reparse point", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const start = source.indexOf("bool grantWritableRoot");
		const end = source.indexOf("bool protectGitControlSurfaces", start);
		const grant = source.slice(start, end);

		expect(grant).toContain("containsReparsePoint");
	});

	it("passes startup-pinned git control surfaces to the Windows helper", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		expect(source).toContain('flag == L"--git-protected"');
		expect(source).toContain("protectGitControlSurface(path, profile.sid, aclScope)");
		expect(source).not.toContain("protectGitControlSurfaces(root");
	});

	it("ships checked-in native source with the required security primitives", () => {
		expect(lowboxHelperSourcePath()).toEndWith(join("native", "bound-lowbox.cpp"));
		expect(existsSync(lowboxHelperSourcePath())).toBe(true);
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		for (const primitive of [
			"BCryptGenRandom",
			"CreateAppContainerProfile",
			"PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES",
			"PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
			"WinCapabilityInternetClientSid",
			"JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
			"SetEntriesInAclW",
			"PROTECTED_DACL_SECURITY_INFORMATION",
			"DeleteAppContainerProfile",
			"recoverStaleAuthority",
		]) {
			expect(source).toContain(primitive);
		}
	});

	it("performs checked local cleanup on every authority-materialized pre-journal return", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const materialized = source.indexOf("AclScope aclScope;");
		const journalPersisted = source.indexOf("wchar_t executable[MAX_PATH]{};", materialized);
		const preJournal = source.slice(materialized, journalPersisted);

		expect(source).toContain("enum class LocalAuthorityCleanupResult");
		expect(source).toContain("restoreMaterializedAuthority(profile, aclScope)");
		expect(preJournal).toContain("failAfterCheckedLocalAuthorityCleanup(");
		// Once a contained process exists, failures either prove that exact
		// suspended process dead before local cleanup, or (after the authority
		// journal is durable) transfer to failAfterDurableAuthorityJournal. The
		// helper-created cancellation peer adds more pre-journal checked-cleanup
		// branches; it does not make a durable journal exist any earlier.
		expect(preJournal).toContain("cleanupAuthorityAfterUncontainedSuspendedChildDeath(");
		expect(preJournal).not.toMatch(/return fail\(/);
		expect(preJournal).not.toContain("LOWBOX_CLEANUP_JOURNAL_PRESERVED");
		expect(source).toContain("for (;;) Sleep(LOWBOX_RECOVERY_RETRY_MS)");
	});

	it("never mutates profile or ACL authority from destructors", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const profileStart = source.indexOf("struct Profile {");
		const profileDestructor = source.slice(profileStart, source.indexOf("};", profileStart));
		const aclStart = source.indexOf("struct AclScope {");
		const aclDestructor = source.slice(aclStart, source.indexOf("};", aclStart));

		expect(profileDestructor).not.toContain("DeleteAppContainerProfile");
		expect(aclDestructor).not.toContain("SetNamedSecurityInfo");
	});

	it("does not terminate while materialized authority lacks a recoverable durable journal", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const cleanupStart = source.indexOf("int failAfterCheckedLocalAuthorityCleanup(");
		const cleanupEnd = source.indexOf("int failAfterDurableAuthorityJournal(", cleanupStart);
		const cleanup = source.slice(cleanupStart, cleanupEnd);

		expect(cleanupStart).toBeGreaterThan(0);
		expect(cleanup).toContain("retryMaterializedAuthorityRecovery(profile, aclScope");
		expect(cleanup).not.toContain("persistAuthorityJournal(profile, aclScope, recoveryPath");
		expect(cleanup).toContain("retryMaterializedAuthorityRecovery(profile, aclScope");
		expect(source).not.toContain("writeRecoveryArtifact");
		expect(source).not.toContain('L".recovery"');
		expect(source).not.toContain('journalPath + L".failed"');
		expect(source).not.toContain("failClosedWithRecoveryArtifact");
		expect(source).not.toContain(
			"TerminateProcess(GetCurrentProcess(), LOWBOX_FAIL_CLOSED_EXIT_CODE)",
		);
		expect(source).not.toContain("ExitProcess(LOWBOX_FAIL_CLOSED_EXIT_CODE)");
	});

	it("uses one checked phase-diagnostic cleanup routine for watcher and startup recovery", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const cleanupStart = source.indexOf(
			"bool cleanupRecoverableAuthorityLocked(",
			source.indexOf("void reportAuthorityCleanupFailure("),
		);
		const cleanupEnd = source.indexOf("bool recoverAuthorityJournalLocked(", cleanupStart);
		const cleanup = source.slice(cleanupStart, cleanupEnd);
		const recoveryStart = cleanupEnd;
		const recoveryEnd = source.indexOf("bool recoverAuthorityJournal(", recoveryStart);
		const recovery = source.slice(recoveryStart, recoveryEnd);
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);

		expect(cleanupStart).toBeGreaterThan(0);
		for (const phase of [
			"close child handle",
			"close job handle",
			"restore ACLs",
			"DeleteAppContainerProfile",
			"DeleteFileW(authority journal)",
		]) {
			expect(source).toContain(phase);
		}
		expect(cleanup).toContain("HRESULT deleted = DeleteAppContainerProfile(");
		expect(cleanup).toContain("captureAuthorityCleanupFailure(");
		expect(cleanup.indexOf("DeleteFileW(path.c_str())")).toBeGreaterThan(
			cleanup.indexOf("DeleteAppContainerProfile("),
		);
		expect(recovery).toContain("cleanupRecoverableAuthorityLocked(path, parsed)");
		expect(watcher).toContain(
			"cleanupRecoverableAuthorityLocked(journalPath, cleanup, &cleanupFailure)",
		);
		expect(watcher).toContain(
			"closeWatcherLowboxHandles(childHandle, jobHandle, reportAuthorityCleanupFailure)",
		);
		expect(watcher.indexOf("closeWatcherLowboxHandles(childHandle, jobHandle")).toBeLessThan(
			watcher.indexOf("cleanupRecoverableAuthorityLocked(journalPath, cleanup, &cleanupFailure)"),
		);
		expect(source).toContain("LOWBOX_WATCHER_CLEANUP");
		expect(watcher).not.toContain("writeControl(");
	});

	it("serializes watcher transfer with stale recovery across the exact unpublished-identity interval", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const recoveryStart = source.indexOf(
			"bool recoverStaleAuthority(const std::wstring& namespaceValue)",
		);
		const recoveryEnd = source.indexOf("std::wstring fullPath", recoveryStart);
		const recovery = source.slice(recoveryStart, recoveryEnd);
		const publicationStart = source.indexOf("std::wstring journalPath;");
		const watcherStart = source.indexOf("if (!startCleanupWatcher(", publicationStart);
		const preWatcher = source.slice(publicationStart, watcherStart);
		const watcher = source.slice(
			source.indexOf("int runCleanupWatcher("),
			source.indexOf("WatcherStartResult startCleanupWatcher("),
		);
		const watcherLaunch = source.slice(
			source.indexOf("WatcherStartResult startCleanupWatcher("),
			source.indexOf("}  // namespace"),
		);
		const duplicateWatcherJob = watcherLaunch.indexOf(
			"DuplicateHandle(GetCurrentProcess(), jobHandle",
		);
		const duplicateWatcherChild = watcherLaunch.indexOf(
			"DuplicateHandle(GetCurrentProcess(), childProcess",
		);
		const createWatcher = watcherLaunch.indexOf("CreateProcessW(executable.c_str()");
		const publicationFunctionStart = source.indexOf(
			"bool publishAuthorityJournalWatcher(const std::wstring& path, DWORD watcherPid",
			source.indexOf("bool rewriteAuthorityJournal("),
		);
		const publicationFunctionEnd = source.indexOf(
			"bool markAuthorityJournalRecoverable(",
			publicationFunctionStart,
		);
		const publication = source.slice(publicationFunctionStart, publicationFunctionEnd);
		const publicationLock = publication.indexOf("AuthorityRecoveryLock recoveryLock(path)");
		const publicationRead = publication.indexOf("readAuthorityJournal(path, parsed)");
		const publicationRewrite = publication.indexOf("rewriteAuthorityJournal(", publicationRead);
		const transferLock = watcherLaunch.indexOf("AuthorityRecoveryLock transferLock");
		const transferRelease = watcherLaunch.indexOf("transferLock.release()");

		expect(source).toContain("enum class AuthorityJournalState");
		expect(source).toContain("Active");
		expect(source).toContain("Recoverable");
		expect(source).toContain("CreateMutexW(");
		expect(source).toContain("WaitForSingleObject(value, INFINITE)");
		expect(source).toContain("wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED");
		expect(source).toContain("ReleaseMutex(value)");
		expect(source).toContain("authorityRecoveryMutexName(");
		expect(recovery).toContain("journal.state != AuthorityJournalState::Recoverable");
		expect(recovery).toContain("reportStaleAuthorityDiagnostic(");
		expect(recovery).not.toContain("isAuthorityJournalOwnerAlive(");
		expect(recovery).not.toContain("isAuthorityJournalWatcherAlive(");
		expect(publicationLock).toBeGreaterThanOrEqual(0);
		expect(publicationLock).toBeLessThan(publicationRead);
		expect(publicationRead).toBeLessThan(publicationRewrite);
		expect(transferLock).toBeGreaterThanOrEqual(0);
		expect(transferLock).toBeLessThan(duplicateWatcherJob);
		expect(duplicateWatcherJob).toBeLessThan(duplicateWatcherChild);
		expect(duplicateWatcherChild).toBeLessThan(createWatcher);
		expect(watcherLaunch).toContain("TRUE, DUPLICATE_SAME_ACCESS");
		expect(watcherLaunch).toContain(
			"HANDLE inherited[] = {inheritedJob.value, inheritedChild.value",
		);
		const watcherReadyWait = watcherLaunch.indexOf("WaitForSingleObject(readyEvent.value");
		const publishIdentity = watcherLaunch.indexOf("publishAuthorityJournalWatcher(");
		const transferReleaseAfterPublish = watcherLaunch.indexOf(
			"transferLock.release()",
			publishIdentity,
		);
		const authorityGrant = watcherLaunch.indexOf("SetEvent(authorityEvent.value)");
		const authorityAcknowledgment = watcherLaunch.indexOf(
			"WaitForSingleObject(authorityArmedEvent.value",
		);
		const watcherActivation = watcher.indexOf("activateAuthorityJournalWatcher(");
		const watcherArmed = watcher.indexOf("SetEvent(authorityArmedEvent)");
		expect(createWatcher).toBeLessThan(watcherReadyWait);
		expect(watcherReadyWait).toBeLessThan(publishIdentity);
		expect(publishIdentity).toBeLessThan(transferReleaseAfterPublish);
		expect(transferReleaseAfterPublish).toBeLessThan(authorityGrant);
		expect(authorityGrant).toBeLessThan(authorityAcknowledgment);
		expect(watcherActivation).toBeGreaterThan(
			watcher.indexOf("WaitForSingleObject(authorityEvent"),
		);
		expect(watcherActivation).toBeLessThan(watcherArmed);
		expect(watcherLaunch).toContain(
			"WaitForSingleObject(readyEvent.value, LOWBOX_WATCHER_TIMEOUT_MS)",
		);
		expect(watcherLaunch).toContain(
			"WaitForSingleObject(authorityArmedEvent.value, LOWBOX_WATCHER_TIMEOUT_MS)",
		);
		expect(watcherLaunch).not.toContain("ReadFile(armedRead.value");
		expect(watcherLaunch).toContain("CreateEventW(");
		expect(watcherLaunch).toContain("TerminateProcess(watcherProcess, 125)");
		expect(watcherLaunch).toContain("ERROR_TIMEOUT");
		expect(watcher).toContain("SetEvent(readyEvent)");
		expect(watcher).toContain("WaitForSingleObject(authorityEvent, INFINITE)");
		expect(watcher).toContain("SetEvent(authorityArmedEvent)");
		expect(watcher).toContain("BOUND_LOWBOX_TEST_WATCHER_NEVER_ARMS");
		expect(watcherLaunch.indexOf("WaitForSingleObject(watcherProcess")).toBeLessThan(
			transferRelease,
		);
		expect(watcherLaunch).toContain("watcherWait == WAIT_OBJECT_0");
		expect(watcherLaunch).toContain("WatcherStartOutcome::FailedPreTransfer");
		const durableJournal = preWatcher.slice(preWatcher.indexOf("if (!persistAuthorityJournal("));
		expect(durableJournal).not.toContain("cleanupAuthorityAfterProvenDeath(");
		expect(durableJournal).toContain("failAfterDurableAuthorityJournal(");
		expect(watcherLaunch).not.toContain("restoreMaterializedAuthority(");
		expect(source).toContain("GetProcessTimes(");
		expect(source).toContain("ownerCreationTime");
		expect(source).toContain("watcherPid");
		expect(source).toContain("watcherCreationTime");
		expect(preWatcher).toContain("AuthorityJournalState::Transferring");
		expect(preWatcher).toContain("GetCurrentProcessId()");
		expect(source).toContain("creationTime == expectedCreationTime");
		expect(recovery).toContain("continue;");
		expect(watcher).toContain("WaitForSingleObject(childHandle, INFINITE)");
		expect(watcher).toContain("waitForJobTreeDeath(jobHandle, childHandle, INFINITE)");
		expect(watcher).toContain("markAuthorityJournalRecoverableLocked(");
		expect(watcher.indexOf("markAuthorityJournalRecoverableLocked(")).toBeGreaterThan(
			watcher.indexOf("waitForJobTreeDeath(jobHandle, childHandle, INFINITE)"),
		);
		expect(watcher).toContain("childPid");
		expect(watcher).toContain("childCreationTime");
		expect(watcher).toContain("jobTreeDeathProof");
		expect(watcher).toContain("processCreationTime(owner.value");
		expect(watcher).toContain("ownerCreationTime != expectedOwnerCreationTime");
		expect(source).toContain("--owner-created");
		expect(source).not.toContain("recoverAuthorityJournal(path, true)");
		const transitionStart = source.indexOf(
			"bool markAuthorityJournalRecoverableLocked(const std::wstring& path, DWORD childPid",
			source.indexOf("bool rewriteAuthorityJournal("),
		);
		const transitionEnd = source.indexOf("bool authorityPathMatchesProfile(", transitionStart);
		const transition = source.slice(transitionStart, transitionEnd);
		expect(transition).not.toContain("AuthorityRecoveryLock recoveryLock(path)");
		expect(transition).toContain("parsed.state != AuthorityJournalState::Active");
		expect(transition).toContain("childPid");
		expect(transition).toContain("childCreationTime");
		expect(transition).toContain("jobTreeDeathProof");
	});
	it("exposes an executable versioned, namespaced authority-journal round-trip and rejection self-test", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const selfTestStart = source.indexOf("int selfTestAuthorityJournal()");
		const selfTestEnd = source.indexOf("int wmain(", selfTestStart);
		const selfTest = source.slice(selfTestStart, selfTestEnd);

		expect(selfTestStart).toBeGreaterThan(0);
		expect(selfTest).toContain("rewriteAuthorityJournal(");
		expect(selfTest).toContain("readAuthorityJournal(");
		expect(selfTest).toContain("validateRecoverableAuthorityJournal(");
		expect(selfTest).toContain("AuthorityJournalState::Active");
		expect(selfTest).toContain("AuthorityJournalState::Recoverable");
		expect(selfTest).toContain('testNamespace = L"journal-self-test"');
		expect(selfTest).toContain('testNamespace = L"separate-watcher"');
		expect(selfTest).toContain("!validateRecoverableAuthorityJournal(path, transitioned)");
		expect(selfTest).toContain("testNamespace = parentNamespace");
		expect(source).toContain("AUTHORITY_JOURNAL_VERSION");
		expect(selfTest).toContain("journalFieldsMatch(parsed, expected)");
		expect(selfTest).toContain("malformed");
		expect(selfTest).toContain("legacyTransferring");
		expect(selfTest).toContain("legacyRecoverable");
		expect(selfTest).toContain("legacyActive");
		expect(selfTest).toContain("writeLegacyJournal(active)");
		expect(selfTest).toContain("journalFieldsMatch(transitioned, recoverable)");
		expect(selfTest).toContain("writeLegacyJournal(transferring)");
		expect(selfTest).toContain("journalFieldsMatch(transitionedTransferring, transferring)");
		expect(source).toContain('std::wstring(argv[1]) == L"self-test-authority-journal"');
	});

	it("propagates and parses the test namespace before cleanup-watcher validation", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const startBegin = source.indexOf("WatcherStartResult startCleanupWatcher(");
		const startEnd = source.indexOf("int selfTestAuthorityJournal()", startBegin);
		const start = source.slice(startBegin, startEnd);
		const parserBegin = source.indexOf(
			'if (argc == 24 && std::wstring(argv[1]) == L"cleanup-watch"',
		);
		const parserEnd = source.indexOf("std::wstring cwd", parserBegin);
		const parser = source.slice(parserBegin, parserEnd);

		expect(startBegin).toBeGreaterThan(0);
		expect(start).toContain('L" --test-namespace " + quoteArgument(testNamespace)');
		expect(parserBegin).toBeGreaterThan(0);
		expect(parser).toContain('std::wstring(argv[22]) == L"--test-namespace"');
		expect(parser).toContain("testNamespace = argv[23]");
		expect(parser.indexOf("testNamespace = argv[23]")).toBeLessThan(
			parser.indexOf("runCleanupWatcher("),
		);
	});

	it("declares native helper types and functions before their first use", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const failedHandoffEnum = source.indexOf("enum class FailedHandoffResolution {");
		const failedHandoffDeclaration = source.indexOf(
			"FailedHandoffResolution resolveFailedHandoffJournal(",
		);
		const recoveryStart = source.indexOf(
			"bool cleanupRecoverableAuthorityLocked(",
			source.indexOf("void reportAuthorityCleanupFailure("),
		);
		const recoveryEnd = source.indexOf(
			"FailedHandoffResolution resolveFailedHandoffJournal(",
			recoveryStart,
		);
		const recovery = source.slice(recoveryStart, recoveryEnd);

		expect(failedHandoffEnum).toBeGreaterThan(0);
		expect(failedHandoffDeclaration).toBeGreaterThan(failedHandoffEnum);
		for (const functionName of ["validateRecoverableAuthorityJournal", "isAuthorityPathAllowed"]) {
			const declaration = source.indexOf(`bool ${functionName}(`);
			const use = recovery.indexOf(`${functionName}(`);
			expect(declaration).toBeGreaterThan(0);
			expect(use).toBeGreaterThan(0);
			expect(declaration).toBeLessThan(recoveryStart);
		}
	});

	it("allows only ConfirmedArmed to reach child readiness through the caller", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const startStart = source.indexOf("WatcherStartResult startCleanupWatcher(");
		const startEnd = source.indexOf("}  // namespace", startStart);
		const start = source.slice(startStart, startEnd);
		const grantFailure = start.slice(
			start.indexOf("if (!SetEvent(authorityEvent.value))"),
			start.indexOf("const DWORD authorityWait"),
		);
		const callerStart = source.indexOf("const WatcherStartResult watcherStart =");
		const callerEnd = source.indexOf("const DWORD childWait", callerStart);
		const caller = source.slice(callerStart, callerEnd);
		const confirmedGate = caller.indexOf(
			"if (watcherStart.outcome != WatcherStartOutcome::ConfirmedArmed)",
		);
		const resume = caller.indexOf("ResumeThread(");
		const ready = caller.lastIndexOf('writeControl("{\\"ok\\":true');

		expect(startStart).toBeGreaterThan(0);
		expect(grantFailure).not.toContain("cancelPreTransferWatcherAndObserve(");
		expect(start).toContain("resolveFailedHandoffJournal(");
		expect(start).toContain("const bool watcherStopped = watcherWait == WAIT_OBJECT_0");
		expect(start).toContain("FailedHandoffResolution::OwnerAuthorityRetained");
		expect(caller).toContain("watcherStart.outcome == WatcherStartOutcome::FailedPreTransfer");
		expect(caller).toContain("failAfterDurableAuthorityJournal(");
		expect(caller).toContain(
			"watcherStart.outcome == WatcherStartOutcome::IndeterminateWatcherOwned",
		);
		expect(caller).not.toContain("requestArmedWatcherCancel();");
		expect(caller).not.toContain("observeIndeterminateWatcherBoundedly();");
		expect(caller).toContain("return failWithoutAuthorityMutation(");
		expect(confirmedGate).toBeGreaterThan(0);
		expect(resume).toBeGreaterThan(confirmedGate);
		expect(ready).toBeGreaterThan(resume);
		expect(caller.slice(0, confirmedGate)).not.toContain("ResumeThread(");
		expect(caller.slice(0, confirmedGate)).not.toContain('writeControl("{\\"ok\\":true');
	});
	it("bounds failed-handoff teardown retries until no dead-watcher journal survives", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const resolutionStart = source.indexOf(
			"FailedHandoffResolution resolveFailedHandoffJournal(",
			source.indexOf("bool restoreAuthorityFromJournalLocked("),
		);
		const resolutionEnd = source.indexOf(
			"bool markAuthorityJournalRecoverableLocked(",
			resolutionStart,
		);
		const resolution = source.slice(resolutionStart, resolutionEnd);

		expect(resolution).toContain("LOWBOX_FAILED_HANDOFF_RESOLUTION_ATTEMPTS");
		expect(resolution).toContain("restoreAuthorityFromJournalLocked(path, parsed)");
		expect(resolution).toContain("DeleteFileW(path.c_str())");
		expect(resolution).toContain("Sleep(LOWBOX_RECOVERY_RETRY_MS)");
		expect(resolution).not.toContain(
			"if (!restoreAuthorityFromJournalLocked(path, parsed)) {\n\t\treturn FailedHandoffResolution::IndeterminateWatcherOwned;",
		);
		expect(resolution).not.toContain(
			"if (!DeleteFileW(path.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) {\n\t\treturn FailedHandoffResolution::IndeterminateWatcherOwned;",
		);
	});

	it("resolves failed pre-transfer journal reset without leaving dead watcher contamination", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const resolutionStart = source.indexOf(
			"FailedHandoffResolution resolveFailedHandoffJournal(",
			source.indexOf("bool restoreAuthorityFromJournalLocked("),
		);
		const resolutionEnd = source.indexOf(
			"bool markAuthorityJournalRecoverableLocked(",
			resolutionStart,
		);
		const resolution = source.slice(resolutionStart, resolutionEnd);
		const cancelStart = source.indexOf("auto cancelPreTransferWatcherAndObserve");
		const cancelEnd = source.indexOf("auto requestArmedWatcherCancelAndObserve", cancelStart);
		const cancel = source.slice(cancelStart, cancelEnd);

		expect(resolutionStart).toBeGreaterThan(0);
		expect(resolution).toContain("AuthorityRecoveryLock recoveryLock(path)");
		expect(resolution).toContain("parsed.state == AuthorityJournalState::Active");
		expect(resolution).toContain("FailedHandoffResolution::IndeterminateWatcherOwned");
		expect(resolution).toContain("parsed.ownerPid != ownerPid");
		expect(resolution).toContain("parsed.ownerCreationTime != ownerCreationTime");
		expect(resolution).toContain("parsed.profileName != profileName");
		expect(resolution).toContain("parsed.watcherPid != watcherPid");
		expect(resolution).toContain("parsed.watcherCreationTime != watcherCreationTime");
		expect(resolution).toContain("rewriteAuthorityJournal(");
		expect(resolution).toContain("TerminateJobObject(jobHandle, 125)");
		expect(resolution).toContain(
			"waitForJobTreeDeath(jobHandle, childHandle, LOWBOX_WATCHER_TIMEOUT_MS)",
		);
		expect(resolution).toContain("restoreAuthorityFromJournalLocked(path, parsed)");
		expect(resolution).toContain("DeleteFileW(path.c_str())");
		expect(cancel).toContain("resolveFailedHandoffJournal(");
		expect(cancel).toContain("FailedHandoffResolution::OwnerAuthorityRetained");
		expect(cancel).toContain("FailedHandoffResolution::OwnerTeardownComplete");
	});

	it("rechecks exact transferring ownership under a fresh lock before parent teardown", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const resolutionStart = source.indexOf(
			"FailedHandoffResolution resolveFailedHandoffJournal(",
			source.indexOf("bool restoreAuthorityFromJournalLocked("),
		);
		const resolutionEnd = source.indexOf(
			"bool markAuthorityJournalRecoverableLocked(",
			resolutionStart,
		);
		const resolution = source.slice(resolutionStart, resolutionEnd);
		const rewrite = resolution.indexOf("if (rewriteAuthorityJournal(");
		const recoveryScopeEnd = resolution.indexOf("\n\t}\n\t// The reset rewrite can fail", rewrite);
		const fallbackLock = resolution.indexOf(
			"AuthorityRecoveryLock fallbackLock(path)",
			recoveryScopeEnd,
		);
		const freshRead = resolution.indexOf("readAuthorityJournal(path, fresh)", fallbackLock);
		const activeGuard = resolution.indexOf(
			"fresh.state == AuthorityJournalState::Active",
			freshRead,
		);
		const identityGuard = resolution.indexOf("fresh.ownerPid != ownerPid", activeGuard);
		const childGuard = resolution.indexOf("fresh.childPid != parsed.childPid", identityGuard);
		const terminate = resolution.indexOf("TerminateJobObject(jobHandle, 125)", childGuard);

		expect(rewrite).toBeGreaterThan(0);
		expect(recoveryScopeEnd).toBeGreaterThan(rewrite);
		expect(fallbackLock).toBeGreaterThan(recoveryScopeEnd);
		expect(freshRead).toBeGreaterThan(fallbackLock);
		expect(activeGuard).toBeGreaterThan(freshRead);
		expect(identityGuard).toBeGreaterThan(activeGuard);
		expect(childGuard).toBeGreaterThan(identityGuard);
		expect(terminate).toBeGreaterThan(childGuard);
		expect(resolution.slice(fallbackLock, terminate)).not.toContain("}\n\tconst BOOL terminated");
	});

	it("does not leave dead-watcher identity when journal deletion exhausts its retries", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const resolutionStart = source.indexOf(
			"FailedHandoffResolution resolveFailedHandoffJournal(",
			source.indexOf("bool restoreAuthorityFromJournalLocked("),
		);
		const resolutionEnd = source.indexOf(
			"bool markAuthorityJournalRecoverableLocked(",
			resolutionStart,
		);
		const resolution = source.slice(resolutionStart, resolutionEnd);

		expect(resolution).toContain("ownerPid, ownerCreationTime, 0, 0");
		expect(resolution).toContain("DeleteFileW(path.c_str())");
		expect(resolution).toContain("rewriteAuthorityJournal(");
		expect(resolution).toContain(
			"if (!authorityRestored) return FailedHandoffResolution::IndeterminateWatcherOwned;",
		);
		expect(resolution).toContain(
			"ownerPid, ownerCreationTime, 0, 0, parsed.childPid, parsed.childCreationTime, true",
		);
		expect(resolution).toContain("FailedHandoffResolution::OwnerAuthorityRetained");
		expect(resolution).not.toContain("AuthorityJournalState::Recoverable");
	});

	it("never kills a watcher once authority signaling can race durable Active ownership", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const startStart = source.indexOf("WatcherStartResult startCleanupWatcher(");
		const startEnd = source.indexOf("}  // namespace", startStart);
		const start = source.slice(startStart, startEnd);
		const preTransferEnd = start.indexOf("auto requestArmedWatcherCancelAndObserve");
		const preTransferCancel = start.slice(
			start.indexOf("auto cancelPreTransferWatcherAndObserve"),
			preTransferEnd,
		);
		const postSignal = start.slice(start.indexOf("if (!SetEvent(authorityEvent.value))"));

		expect(preTransferCancel).toContain("TerminateProcess(watcherProcess, 125)");
		expect(postSignal).not.toContain("cancelPreTransferWatcherAndObserve(");
		expect(postSignal).toContain("requestArmedWatcherCancelAndObserve(");
		expect(postSignal).toContain("observeFailedArmedWait(");
		expect(postSignal).not.toContain("TerminateProcess(watcherProcess, 125)");
	});

	it("reports every Active ACK-loss cancel result through the watcher report", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const startStart = source.indexOf("WatcherStartResult startCleanupWatcher(");
		const startEnd = source.indexOf("}  // namespace", startStart);
		const start = source.slice(startStart, startEnd);
		const cancelStart = start.indexOf("requestArmedWatcherCancelAndObserve");
		const cancelEnd = start.indexOf("observeFailedArmedWait", cancelStart);
		const cancel = start.slice(cancelStart, cancelEnd);

		expect(start).toContain("journal.state == AuthorityJournalState::Active");
		expect(cancel).toContain('const char cancelFrame[] = "CANCEL\\n"');
		expect(cancel).toContain("ReadFile(watcherReportRead.value");
		expect(cancel).toContain("report.cleanupResult");
		expect(cancel).toContain("report.operation");
		expect(cancel).toContain("LOWBOX_WATCHER_CANCEL_SENT");
		expect(cancel).toContain("LOWBOX_WATCHER_CANCEL_WRITE_FAILED");
		expect(cancel).toContain("LOWBOX_WATCHER_CLEANUP");
		expect(cancel).toContain("LOWBOX_WATCHER_REPORT_FAILED");
		expect(cancel).toContain("WatcherStartOutcome::IndeterminateWatcherOwned");
		expect(cancel).not.toContain("WaitForSingleObject(watcherProcess");
		expect(cancel).not.toContain("GetExitCodeProcess(watcherProcess");
		expect(cancel).not.toContain("WatcherStartOutcome::ConfirmedArmed");
		expect(cancel).not.toContain("WatcherStartOutcome::FailedPreTransfer");
	});

	it("fails closed for abandoned Active and Transferring journals and cleans only Recoverable", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const recoveryStart = source.indexOf(
			"bool recoverStaleAuthority(const std::wstring& namespaceValue)",
		);
		const recoveryEnd = source.indexOf("std::wstring fullPath", recoveryStart);
		const recovery = source.slice(recoveryStart, recoveryEnd);

		expect(source).toContain("Transferring");
		expect(recovery).toContain("journal.state != AuthorityJournalState::Recoverable");
		expect(recovery).toContain("reportStaleAuthorityDiagnostic(path, journal)");
		expect(recovery).toContain("recoverAuthorityJournalLocked(path)");
		expect(recovery).not.toContain("recoverAuthorityJournal(path, true)");
		expect(recovery).not.toContain("isAuthorityJournalOwnerAlive(");
		expect(recovery).not.toContain("isAuthorityJournalWatcherAlive(");
		expect(source).toContain("LOWBOX_STALE_AUTHORITY_ACTIVE");
		expect(source).toContain("LOWBOX_STALE_AUTHORITY_TRANSFERRING");
		expect(source).toContain("journal.ownerPid");
		expect(source).toContain("journal.ownerCreationTime");
		expect(source).toContain("journal.watcherPid");
		expect(source).toContain("journal.watcherCreationTime");
	});

	it("keeps the armed watcher as sole executor while accepting explicit cancel requests", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);
		const postArmStart = source.indexOf("const WatcherStartResult watcherStart =");
		const postArm = source.slice(postArmStart);

		expect(watcher).toContain("WaitForMultipleObjects(");
		expect(watcher).toContain("owner.value");
		expect(watcher).toContain("controlRead");
		expect(watcher).toContain('const char cancelFrame[] = "CANCEL\\n"');
		expect(watcher).toContain("controlFrame != cancelFrame");
		expect(watcher).toContain("ERROR_BROKEN_PIPE");
		expect(watcher).toContain("HANDLE lifecycleSignals[] = {childHandle, owner.value}");
		expect(watcher).toContain("TerminateJobObject(jobHandle, 125)");
		expect(watcher).toContain("WaitForSingleObject(childHandle, INFINITE)");
		expect(watcher).toContain("waitForJobTreeDeath(jobHandle, childHandle, INFINITE)");
		expect(watcher.indexOf("waitForJobTreeDeath(jobHandle, childHandle, INFINITE)")).toBeLessThan(
			watcher.indexOf("markAuthorityJournalRecoverableLocked("),
		);
		expect(watcher).toContain("AuthorityRecoveryLock recoveryLock(journalPath)");
		expect(watcher).toContain(
			"cleanupRecoverableAuthorityLocked(journalPath, cleanup, &cleanupFailure)",
		);

		for (const forbidden of [
			"TerminateJobObject(",
			"restoreMaterializedAuthority(",
			"markAuthorityJournalRecoverableLocked(",
			"recoverAuthorityJournalLocked(",
		]) {
			expect(postArm).not.toContain(forbidden);
		}
		expect(postArm).toContain("requestArmedWatcherCancelAndObserve(");
	});

	it("fails closed for abandoned Active and Transferring journals and cleans only valid Recoverable work", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const startupStart = source.indexOf(
			"bool recoverStaleAuthority(const std::wstring& namespaceValue)",
		);
		const startupEnd = source.indexOf("std::wstring fullPath", startupStart);
		const startup = source.slice(startupStart, startupEnd);
		const recoveryStart = source.indexOf("bool recoverAuthorityJournalLocked(");
		const recoveryEnd = source.indexOf("bool recoverAuthorityJournal(", recoveryStart);
		const recovery = source.slice(recoveryStart, recoveryEnd);

		expect(startup).toContain("AuthorityRecoveryLock recoveryLock(path)");
		expect(startup).toContain("journal.state != AuthorityJournalState::Recoverable");
		expect(startup).toContain("reportStaleAuthorityDiagnostic(path, journal)");
		expect(startup).not.toContain("isProcessIdentityAlive(");
		expect(recovery).toContain("validateRecoverableAuthorityJournal(path, parsed)");
		expect(recovery).toContain("isAuthorityPathAllowed(parsed.authorityLines[i - 2])");
		expect(
			recovery.indexOf("DeleteAppContainerProfile(parsed.profileName.c_str())"),
		).toBeGreaterThan(recovery.indexOf("validateRecoverableAuthorityJournal("));
	});
	it("transfers child and job handle ownership completely after the watcher arms", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const postArmStart = source.indexOf("const WatcherStartResult watcherStart =");
		const postArm = source.slice(postArmStart);
		const armedGate = postArm.indexOf(
			"watcherStart.outcome != WatcherStartOutcome::ConfirmedArmed",
		);
		const terminalWait = postArm.indexOf("awaitArmedWatcherTerminalStatus(");
		const ownerRuntime = postArm.slice(armedGate, terminalWait);

		expect(ownerRuntime).toContain("childProcess.reset()");
		expect(ownerRuntime).toContain("job.reset()");
		expect(ownerRuntime).not.toContain("WaitForSingleObject(childProcess.value");
		expect(ownerRuntime).not.toContain("GetExitCodeProcess(childProcess.value");
		expect(ownerRuntime).not.toContain("queryJobTreeEmpty(job.value");
	});

	it("receives child exit and cleanup diagnostics from the watcher report pipe", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);
		const terminalStart = source.indexOf("WatcherTerminalStatus awaitArmedWatcherTerminalStatus(");
		const terminalEnd = source.indexOf("bool queryJobTreeEmpty", terminalStart);
		const terminal = source.slice(terminalStart, terminalEnd);

		expect(source).toContain("watcherReportRead");
		expect(source).toContain("watcherReportWrite");
		expect(watcher).toContain("GetExitCodeProcess(childHandle, &report.childExitCode)");
		expect(watcher).toContain("WriteFile(reportWrite");
		expect(watcher).toContain("report.cleanupResult");
		expect(watcher).not.toContain("writeControl(");
		expect(terminal).toContain("ReadFile(watcherReportRead");
		expect(terminal).toContain("WatcherTerminalReport& report");
		expect(terminal).toContain("report.cleanupResult");
	});

	it("treats failed job assignment as an uncontained suspended child, not a process tree", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const assignmentStart = source.indexOf("if (!AssignProcessToJobObject(");
		const assignmentEnd = source.indexOf("ULONGLONG ownerCreationTime", assignmentStart);
		const assignmentFailure = source.slice(assignmentStart, assignmentEnd);

		expect(assignmentStart).toBeGreaterThan(0);
		expect(assignmentFailure).toContain(
			"cleanupAuthorityAfterUncontainedSuspendedChildDeath(childProcess.value",
		);
		expect(assignmentFailure).not.toContain("cleanupAuthorityAfterProvenDeath(job.value");

		const cleanupStart = source.indexOf("int cleanupAuthorityAfterUncontainedSuspendedChildDeath(");
		const cleanupEnd = source.indexOf("int failAfterDurableAuthorityJournal(", cleanupStart);
		const cleanup = source.slice(cleanupStart, cleanupEnd);
		expect(cleanupStart).toBeGreaterThan(0);
		expect(cleanup).toContain("TerminateProcess(childHandle, exitCode)");
		expect(cleanup).toContain("WaitForSingleObject(childHandle, LOWBOX_WATCHER_TIMEOUT_MS)");
		expect(cleanup).toContain("retrySuspendedChildDeathBeforeAuthorityCleanup(");
		expect(cleanup).not.toContain("persistAuthorityJournal(");
	});

	it("sends one framed cancel request and makes watcher failure durably recoverable", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const terminalStart = source.indexOf("WatcherTerminalStatus awaitArmedWatcherTerminalStatus(");
		const terminalEnd = source.indexOf("bool queryJobTreeEmpty", terminalStart);
		const terminal = source.slice(terminalStart, terminalEnd);
		const requestStart = source.indexOf("void requestArmedWatcherCancel()");
		const requestEnd = source.indexOf(
			"[[noreturn]] void requestArmedWatcherCancelAndObserve()",
			requestStart,
		);
		const request = source.slice(requestStart, requestEnd);
		const watcherStart = source.indexOf("int runCleanupWatcher(");
		const watcherEnd = source.indexOf("WatcherStartResult startCleanupWatcher(", watcherStart);
		const watcher = source.slice(watcherStart, watcherEnd);

		expect(source).toContain("enum class WatcherTerminalStatus");
		for (const result of ["WatcherAbnormalExit", "CleanupComplete"]) {
			expect(source).toContain(result);
		}
		expect(source).not.toContain("WatcherTimedOut");
		expect(request).toContain('const char cancelFrame[] = "CANCEL\\n"');
		expect(request).toContain("WriteFile(watcherControlWrite");
		expect(request).toContain("CloseHandle(watcherControlWrite)");
		expect(source).not.toContain("closeCleanupWatcher");
		expect(source).toContain("requestArmedWatcherCancelAndObserve();");
		expect(terminal).toContain("WaitForSingleObject(cleanupWatcher, 0)");
		expect(terminal).not.toContain("GetExitCodeProcess(cleanupWatcher");
		expect(source).not.toContain("awaitArmedWatcherTerminalStatusOrRetry");
		expect(watcher).toContain("markAuthorityJournalRecoverableLocked(");
		expect(watcher.indexOf("markAuthorityJournalRecoverableLocked(")).toBeLessThan(
			watcher.indexOf("cleanupRecoverableAuthorityLocked(journalPath, cleanup, &cleanupFailure)"),
		);
		expect(source).toContain(
			"if (watcherStatus != WatcherTerminalStatus::CleanupComplete) reportArmedWatcherAbnormalExit();",
		);
	});

	it("closes every handoff-time terminal observation handle and stream", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const start = source.indexOf(
			"auto requestArmedWatcherCancelAndObserve = [&](DWORD failure) -> WatcherStartResult",
		);
		const end = source.indexOf("auto observeFailedArmedWait", start);
		const request = source.slice(start, end);

		expect(start).toBeGreaterThan(0);
		expect(request).toContain('const char cancelFrame[] = "CANCEL\\n"');
		expect(request.indexOf("controlWrite.reset()")).toBeGreaterThan(
			request.indexOf("WriteFile(controlWrite.value"),
		);
		expect(request).toContain("ReadFile(watcherReportRead.value");
		expect(request).toContain("report.cleanupResult");
		expect(request).toContain("report.operation");
		expect(request).toContain("watcherReportRead.reset()");
		expect(request).toContain("watcherReportWrite.reset()");
		expect(request).not.toContain("WaitForSingleObject(watcherProcess");
		expect(request).not.toContain("GetExitCodeProcess(watcherProcess");
		expect(request).not.toContain("cleanupWatcher.reset()");
		expect(request).toContain("const HANDLE watcherToClose = watcherProcess");
		expect(request).toContain("watcherProcess = INVALID_HANDLE_VALUE");
		expect(request).toContain("CloseHandle(watcherToClose)");
		expect(request.indexOf("ReadFile(watcherReportRead.value")).toBeLessThan(
			request.indexOf("CloseHandle(watcherToClose)"),
		);
	});

	it("declares cleanupWatcher as a raw HANDLE before every lifecycle use", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const declaration = source.indexOf("HANDLE cleanupWatcher = INVALID_HANDLE_VALUE;");
		const firstLifecycleUse = source.indexOf("cleanupWatcher", declaration + 1);

		expect(declaration).toBeGreaterThan(0);
		expect(firstLifecycleUse).toBeGreaterThan(declaration);
		expect(source).not.toContain("cleanupWatcher.reset()");
		expect(source).not.toMatch(/cleanupWatcher\s*[!=]=\s*nullptr/);
		expect(source).not.toContain("cleanupWatcher = nullptr");
	});

	it("bounds runtime watcher-report observation and closes every handle and stream", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const closeStart = source.indexOf("void closeArmedWatcherObservationHandles()");
		const terminalStart = source.indexOf("WatcherTerminalStatus awaitArmedWatcherTerminalStatus(");
		const terminalEnd = source.indexOf("bool queryJobTreeEmpty", terminalStart);
		const close = source.slice(closeStart, terminalStart);
		const terminal = source.slice(terminalStart, terminalEnd);

		expect(closeStart).toBeGreaterThan(0);
		expect(terminalStart).toBeGreaterThan(closeStart);
		expect(close).toContain("watcherControlWrite = nullptr");
		expect(close).toContain("watcherReportRead = nullptr");
		expect(close).toContain("cleanupWatcher = INVALID_HANDLE_VALUE");
		expect(terminal).toContain("PeekNamedPipe(watcherReportRead");
		expect(terminal).toContain("LOWBOX_WATCHER_TIMEOUT_MS");
		expect(terminal).toContain("WaitForSingleObject(cleanupWatcher");
		expect(terminal.match(/closeArmedWatcherObservationHandles\(\)/g)).toHaveLength(2);
		expect(
			terminal.indexOf("closeArmedWatcherObservationHandles()", terminal.indexOf("ReadFile(")),
		).toBeGreaterThan(terminal.indexOf("ReadFile(watcherReportRead"));
	});

	it("keeps every post-watcher failure branch on the explicit cancel path", () => {
		const source = readFileSync(lowboxHelperSourcePath(), "utf8");
		const watcherInstalled = source.indexOf("const WatcherStartResult watcherStart =");
		const watcherActive = source.indexOf("wchar_t failAfterWatcher", watcherInstalled);
		const postWatcherInstall = source.slice(watcherActive);
		const notifications = postWatcherInstall.match(/requestArmedWatcherCancelAndObserve\(/g) ?? [];

		// Forwarding failure, test-descendant resume failure, primary-shell resume
		// failure, and the explicit fail-after-watcher test hook all converge on
		// the watcher-owned cancel path.
		expect(notifications).toHaveLength(4);
		expect(postWatcherInstall).not.toContain("recoverAuthorityJournal(journalPath)");
		expect(postWatcherInstall).not.toContain("cleanupWatcher = nullptr");
		expect(postWatcherInstall).not.toContain("cleanupWatcher = INVALID_HANDLE_VALUE");
		expect(postWatcherInstall).not.toContain("restoreMaterializedAuthority(");
		expect(postWatcherInstall).not.toContain("persistAuthorityJournal(");
		expect(postWatcherInstall).not.toContain("TerminateJobObject(");
		expect(source).toContain('GetEnvironmentVariableW(L"BOUND_LOWBOX_TEST_FAIL_AFTER_WATCHER"');
	});

	it("uses one unambiguous flag protocol shared with the native helper", () => {
		expect(
			buildLowboxArgs("Write-Output hi", "C:\\work", "C:\\repo", shell, sandbox, "C:\\tmp", "1234"),
		).toEqual([
			"spawn",
			"--control-handle",
			"1234",
			"--cwd",
			"C:\\work",
			"--shell",
			shell.command,
			"--shell-flag",
			"-Command",
			"--command",
			"Write-Output hi",
			"--network",
			"open",
			"--writable",
			"C:\\repo",
			"--writable",
			"C:\\work",
			"--writable",
			"C:\\tmp",
			"--writable",
			"C:\\extra root",
		]);
	});

	it("parses escaped structured native failures", () => {
		expect(
			parseLowboxFailure(
				'{"ok":false,"code":"LOWBOX_CREATE_PROCESS","operation":"CreateProcessW","win32":5,"message":"Access is denied.\\r\\n"}',
			),
		).toEqual({
			ok: false,
			code: "LOWBOX_CREATE_PROCESS",
			operation: "CreateProcessW",
			win32: 5,
			message: "Access is denied.\r\n",
		});
	});

	it("drains terminal watcher diagnostics separately from child streams", () => {
		const source = readFileSync(join(import.meta.dir, "..", "tools", "lowbox-runtime.ts"), "utf8");
		const readinessStart = source.indexOf('let controlPending = ""');
		const returnStart = source.indexOf("const toWeb", readinessStart);
		const runtime = source.slice(readinessStart, returnStart);

		expect(runtime).toContain("terminalWatcherDiagnostics");
		expect(runtime).toContain('control.on("data"');
		expect(runtime).toContain('control.on("end"');
		expect(runtime).toContain("console.error");
		expect(runtime).not.toContain("child.stderr?.push");
	});

	it("refuses an absent helper with a structured availability error", () => {
		expect(() =>
			resolveLowboxHelperPath({
				platform: "win32",
				executablePath: "Z:\\missing.exe",
				helperPath: undefined,
				allowEmbedded: false,
			}),
		).toThrow(/LOWBOX_HELPER_UNAVAILABLE/);
	});

	it("refuses unsupported platforms", () => {
		expect(() => resolveLowboxHelperPath({ platform: "darwin" })).toThrow(
			/LOWBOX_HELPER_UNAVAILABLE/,
		);
	});

	it("materializes the embedded helper under a content-hash dir and reuses it", () => {
		const dir = mkdtempSync(join(tmpdir(), "lowbox-embedded-"));
		// Materialize under a tmpdir base rather than the real home directory —
		// the default base writes to ~/.bound, which is unwritable under the
		// boundless sandbox and pollutes the developer's home dir on every run.
		const base = join(dir, "lowbox-runtime");
		const hash = "embedtest-hash";
		const staged = join(dir, "staged.exe");
		writeFileSync(staged, "MZ-fake-helper-bytes");

		const materialized = materializeLowboxHelper(hash, staged, base);
		expect(materialized).toContain(join("lowbox-runtime", hash));
		expect(existsSync(materialized)).toBe(true);
		expect(readFileSync(materialized, "utf8")).toBe("MZ-fake-helper-bytes");

		// Second call is a no-op even if the staged bytes changed (content-hash
		// directory names separate versions).
		writeFileSync(staged, "MZ-different");
		expect(readFileSync(materializeLowboxHelper(hash, staged, base), "utf8")).toBe(
			"MZ-fake-helper-bytes",
		);

		rmSync(dir, { recursive: true, force: true });
	});
});
