#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <io.h>
#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cwctype>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace {
extern HANDLE cleanupWatcher;
extern HANDLE watcherControlWrite;
extern HANDLE watcherReportRead;
struct Handle {
	HANDLE value = nullptr;
	~Handle() { reset(); }
	Handle() = default;
	Handle(const Handle&) = delete;
	Handle& operator=(const Handle&) = delete;
	Handle(Handle&& other) noexcept : value(other.release()) {}
	Handle& operator=(Handle&& other) noexcept {
		if (this != &other) reset(other.release());
		return *this;
	}
	void reset(HANDLE next = nullptr) {
		if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
		value = next;
	}
	HANDLE release() {
		HANDLE out = value;
		value = nullptr;
		return out;
	}
	operator HANDLE() const { return value; }
};

struct FindHandle {
	HANDLE value = INVALID_HANDLE_VALUE;
	~FindHandle() {
		if (value != INVALID_HANDLE_VALUE) FindClose(value);
	}
	FindHandle() = default;
	FindHandle(const FindHandle&) = delete;
	FindHandle& operator=(const FindHandle&) = delete;
	operator HANDLE() const { return value; }
};

struct Profile {
	std::wstring name;
	PSID sid = nullptr;
	bool owned = false;
	~Profile() {
		if (sid) FreeSid(sid);
	}
};

struct SavedSecurity {
	std::wstring path;
	PSECURITY_DESCRIPTOR descriptor = nullptr;
	PSID owner = nullptr;
	PSID group = nullptr;
	PACL dacl = nullptr;
	bool daclProtected = false;
	~SavedSecurity() {
		if (descriptor) LocalFree(descriptor);
	}
};

struct AclScope {
	std::vector<std::unique_ptr<SavedSecurity>> saved;
	~AclScope() = default;
};

struct AttributeList {
	LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
	~AttributeList() {
		if (value) {
			DeleteProcThreadAttributeList(value);
			HeapFree(GetProcessHeap(), 0, value);
		}
	}
};

std::wstring windowsMessage(DWORD code) {
	wchar_t* text = nullptr;
	FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
		FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, code, 0, reinterpret_cast<wchar_t*>(&text), 0,
		nullptr);
	std::wstring out = text ? text : L"unknown Windows error";
	if (text) LocalFree(text);
	return out;
}

std::string utf8(const std::wstring& value) {
	if (value.empty()) return {};
	const int bytes = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
		nullptr, 0, nullptr, nullptr);
	std::string out(static_cast<size_t>(bytes), '\0');
	WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), bytes,
		nullptr, nullptr);
	return out;
}

std::wstring wide(const std::string& value) {
	if (value.empty()) return {};
	const int chars = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
		nullptr, 0);
	std::wstring out(static_cast<size_t>(chars), L'\0');
	MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), chars);
	return out;
}

std::string jsonEscape(const std::string& value) {
	std::string out;
	for (unsigned char ch : value) {
		switch (ch) {
			case '\\': out += "\\\\"; break;
			case '"': out += "\\\""; break;
			case '\r': out += "\\r"; break;
			case '\n': out += "\\n"; break;
			case '\t': out += "\\t"; break;
			default:
				if (ch < 0x20) {
					char escaped[7];
					sprintf_s(escaped, "\\u%04x", ch);
					out += escaped;
				} else {
					out.push_back(static_cast<char>(ch));
				}
		}
	}
	return out;
}

HANDLE controlHandle = INVALID_HANDLE_VALUE;
HANDLE cleanupWatcher = INVALID_HANDLE_VALUE;
HANDLE watcherControlWrite = nullptr;
HANDLE watcherReportRead = nullptr;
std::wstring cleanupJournalPath;
std::wstring testNamespace;
constexpr DWORD LOWBOX_WATCHER_TIMEOUT_MS = 5000;
constexpr DWORD LOWBOX_RECOVERY_RETRY_MS = 1000;
constexpr DWORD LOWBOX_FAILED_HANDOFF_RESOLUTION_ATTEMPTS = 5;
constexpr wchar_t AUTHORITY_JOURNAL_VERSION[] = L"bound-lowbox-authority-v1";

enum class LocalAuthorityCleanupResult {
	CleanupComplete,
	AclRestoreFailed,
	ProfileDeleteFailed,
};

enum class AuthorityJournalState {
	Transferring,
	Active,
	Recoverable,
};

struct AuthorityJournal {
	AuthorityJournalState state = AuthorityJournalState::Recoverable;
	DWORD ownerPid = 0;
	ULONGLONG ownerCreationTime = 0;
	DWORD watcherPid = 0;
	ULONGLONG watcherCreationTime = 0;
	DWORD childPid = 0;
	ULONGLONG childCreationTime = 0;
	bool jobTreeDeathProof = false;
	std::wstring profileName;
	std::vector<std::wstring> authorityLines;
};

enum class FailedHandoffResolution {
	OwnerAuthorityRetained,
	OwnerTeardownComplete,
	IndeterminateWatcherOwned,
};

std::wstring authorityJournalPath(const std::wstring& profileName);
std::wstring authorityJournalPattern(const std::wstring& namespaceValue);
bool verifyAuthorityJournal(const std::wstring& path);
bool publishAuthorityJournalWatcher(const std::wstring& path, DWORD watcherPid,
	ULONGLONG watcherCreationTime);
FailedHandoffResolution resolveFailedHandoffJournal(const std::wstring& path,
	const std::wstring& profileName, DWORD ownerPid, ULONGLONG ownerCreationTime, DWORD watcherPid,
	ULONGLONG watcherCreationTime, HANDLE jobHandle, HANDLE childHandle);
bool markAuthorityJournalRecoverableLocked(const std::wstring& path, DWORD childPid,
	ULONGLONG childCreationTime, bool jobTreeDeathProof);
struct AuthorityCleanupFailure {
	std::wstring operation;
	DWORD win32 = ERROR_SUCCESS;
	HRESULT hresult = S_OK;
};

bool cleanupRecoverableAuthorityLocked(const std::wstring& path, const AuthorityJournal& parsed,
	AuthorityCleanupFailure* failure = nullptr);
bool recoverAuthorityJournalLocked(const std::wstring& path);
bool authorityPathMatchesProfile(const std::wstring& path, const std::wstring& profileName);
bool validateRecoverableAuthorityJournal(const std::wstring& path, const AuthorityJournal& parsed);
bool isAuthorityPathAllowed(const std::wstring& path);
bool isReparsePoint(const std::wstring& path);

LocalAuthorityCleanupResult restoreMaterializedAuthority(Profile& profile, AclScope& aclScope);
bool persistAuthorityJournal(const Profile& profile, const AclScope& scope,
	std::wstring& journalPath, AuthorityJournalState state, DWORD ownerPid,
	ULONGLONG ownerCreationTime, DWORD watcherPid, ULONGLONG watcherCreationTime,
	DWORD childPid, ULONGLONG childCreationTime, bool jobTreeDeathProof);
[[noreturn]] void retryMaterializedAuthorityRecovery(Profile& profile, AclScope& scope,
	DWORD journalError);
int fail(const char* code, const wchar_t* operation, DWORD win32);
void writeControl(const std::string& json);
enum class WatcherTerminalStatus {
	CleanupComplete,
	CleanupFailed,
	WatcherAbnormalExit,
};

struct WatcherTerminalReport {
	DWORD magic;
	DWORD childExitCode;
	DWORD cleanupResult;
	DWORD win32;
	HRESULT hresult;
	wchar_t operation[96];
};

constexpr DWORD LOWBOX_WATCHER_REPORT_MAGIC = 0x42575250;

enum class WatcherStartOutcome {
	ConfirmedArmed,
	FailedPreTransfer,
	FailedAfterWatcherCleanup,
	IndeterminateWatcherOwned,
};


struct WatcherStartResult {
	WatcherStartOutcome outcome;
	DWORD win32;
};

void closeArmedWatcherObservationHandles() {
	if (watcherControlWrite != nullptr) CloseHandle(watcherControlWrite);
	watcherControlWrite = nullptr;
	if (watcherReportRead != nullptr) CloseHandle(watcherReportRead);
	watcherReportRead = nullptr;
	if (cleanupWatcher != INVALID_HANDLE_VALUE) CloseHandle(cleanupWatcher);
	cleanupWatcher = INVALID_HANDLE_VALUE;
}

WatcherTerminalStatus awaitArmedWatcherTerminalStatus(WatcherTerminalReport& report) {
	if (cleanupWatcher == INVALID_HANDLE_VALUE || watcherReportRead == nullptr) {
		closeArmedWatcherObservationHandles();
		return WatcherTerminalStatus::WatcherAbnormalExit;
	}
	if (watcherControlWrite != nullptr) CloseHandle(watcherControlWrite);
	watcherControlWrite = nullptr;
	const ULONGLONG started = GetTickCount64();
	bool reportReady = false;
	for (;;) {
		DWORD available = 0;
		if (!PeekNamedPipe(watcherReportRead, nullptr, 0, nullptr, &available, nullptr)) break;
		if (available >= sizeof(report)) {
			reportReady = true;
			break;
		}
		if (WaitForSingleObject(cleanupWatcher, 0) == WAIT_OBJECT_0) break;
		if (GetTickCount64() - started >= LOWBOX_WATCHER_TIMEOUT_MS) break;
		Sleep(10);
	}
	DWORD bytesRead = 0;
	const bool reportRead = reportReady &&
		ReadFile(watcherReportRead, &report, sizeof(report), &bytesRead, nullptr) &&
		bytesRead == sizeof(report) && report.magic == LOWBOX_WATCHER_REPORT_MAGIC;
	closeArmedWatcherObservationHandles();
	cleanupJournalPath.clear();
	if (!reportRead) return WatcherTerminalStatus::WatcherAbnormalExit;
	return report.cleanupResult == 0 ? WatcherTerminalStatus::CleanupComplete
		: WatcherTerminalStatus::CleanupFailed;
}

bool queryJobTreeEmpty(HANDLE jobHandle, bool& empty) {
	JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
	if (!QueryInformationJobObject(jobHandle, JobObjectBasicAccountingInformation, &accounting,
			sizeof(accounting), nullptr)) return false;
	empty = accounting.ActiveProcesses == 0;
	return true;
}

bool waitForJobTreeDeath(HANDLE jobHandle, HANDLE childHandle, DWORD timeoutMs) {
	const ULONGLONG started = GetTickCount64();
	for (;;) {
		bool empty = false;
		if (!queryJobTreeEmpty(jobHandle, empty)) return false;
		if (empty) return true;
		if (timeoutMs != INFINITE) {
			const ULONGLONG elapsed = GetTickCount64() - started;
			if (elapsed >= timeoutMs) return false;
		}
		const DWORD remaining = timeoutMs == INFINITE
			? INFINITE
			: static_cast<DWORD>(timeoutMs - (GetTickCount64() - started));
		const DWORD wait = WaitForSingleObject(childHandle, remaining);
		if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) return false;
		if (wait == WAIT_TIMEOUT) return false;
		Sleep(10);
	}
}


void requestArmedWatcherCancel() {
	if (watcherControlWrite == nullptr) return;
	const char cancelFrame[] = "CANCEL\n";
	DWORD written = 0;
	WriteFile(watcherControlWrite, cancelFrame, sizeof(cancelFrame) - 1, &written, nullptr);
	CloseHandle(watcherControlWrite);
	watcherControlWrite = nullptr;
}

void observeIndeterminateWatcherBoundedly() {
	if (cleanupWatcher == INVALID_HANDLE_VALUE) return;
	WaitForSingleObject(cleanupWatcher, LOWBOX_WATCHER_TIMEOUT_MS);
}

int failWithoutAuthorityMutation(const char* code, const wchar_t* operation, DWORD win32) {
	const std::string json = "{\"ok\":false,\"code\":\"" + std::string(code) +
		"\",\"operation\":\"" + jsonEscape(utf8(operation)) + "\",\"win32\":" +
		std::to_string(win32) + ",\"message\":\"" + jsonEscape(utf8(windowsMessage(win32))) +
		"\"}";
	writeControl(json);
	return 125;
}

[[noreturn]] void requestArmedWatcherCancelAndObserve() {
	requestArmedWatcherCancel();
	WatcherTerminalReport report{};
	const WatcherTerminalStatus status = awaitArmedWatcherTerminalStatus(report);
	if (status == WatcherTerminalStatus::CleanupFailed) {
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_WATCHER_CLEANUP\",\"operation\":\"" +
			jsonEscape(utf8(report.operation)) + "\",\"win32\":" + std::to_string(report.win32) +
			",\"hresult\":" + std::to_string(report.hresult) + "}");
	}
	ExitProcess(status == WatcherTerminalStatus::CleanupComplete ? 125 : 126);
}

[[noreturn]] void reportArmedWatcherAbnormalExit() {
	// The watcher process has already terminated, so cancellation cannot be delivered. The owner still
	// performs no authority mutation; startup can recover only if the watcher durably published
	// Recoverable after proving exact job-tree death.
	ExitProcess(126);
}


int failAfterCheckedLocalAuthorityCleanup(const char* code, const wchar_t* operation, DWORD win32,
	Profile& profile, AclScope& aclScope) {
	const LocalAuthorityCleanupResult cleanup = restoreMaterializedAuthority(profile, aclScope);
	if (cleanup == LocalAuthorityCleanupResult::CleanupComplete) {
		return fail(code, operation, win32);
	}

	// Cleanup did not finish, so preserve the still-owned profile and saved ACL state
	// in the same journal format consumed by next-start recovery. Destructors must not
	// retry authority mutation: this durable artifact is the only recovery owner.
	// No child was created on this path, so perform checked cleanup locally; never mint a
	// Recoverable journal without an exact child/job-tree death proof.
	retryMaterializedAuthorityRecovery(profile, aclScope, GetLastError());
}

[[noreturn]] void retrySuspendedChildDeathBeforeAuthorityCleanup(HANDLE childHandle, DWORD exitCode,
	Profile& profile, AclScope& aclScope) {
	// AssignProcessToJobObject failed while the primary thread was still suspended, so no child code
	// has run and no descendants can exist. Keep this owner alive until that exact process is dead;
	// unlike a job-contained tree, ordinary stale recovery has no independent liveness proof here.
	for (;;) {
		TerminateProcess(childHandle, exitCode);
		if (WaitForSingleObject(childHandle, LOWBOX_WATCHER_TIMEOUT_MS) == WAIT_OBJECT_0) {
			const LocalAuthorityCleanupResult cleanup = restoreMaterializedAuthority(profile, aclScope);
			if (cleanup == LocalAuthorityCleanupResult::CleanupComplete) ExitProcess(exitCode);
		}
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_SUSPENDED_CHILD_DEATH_RECOVERY_RETRY\","
			"\"operation\":\"TerminateProcess/WaitForSingleObject\"}");
		Sleep(LOWBOX_RECOVERY_RETRY_MS);
	}
}

int cleanupAuthorityAfterUncontainedSuspendedChildDeath(HANDLE childHandle, DWORD exitCode,
	const char* code, const wchar_t* operation, DWORD win32, Profile& profile, AclScope& aclScope) {
	const BOOL terminated = TerminateProcess(childHandle, exitCode);
	const DWORD childWait = WaitForSingleObject(childHandle, LOWBOX_WATCHER_TIMEOUT_MS);
	if (!terminated || childWait != WAIT_OBJECT_0) {
		retrySuspendedChildDeathBeforeAuthorityCleanup(childHandle, exitCode, profile, aclScope);
	}
	const LocalAuthorityCleanupResult cleanup = restoreMaterializedAuthority(profile, aclScope);
	if (cleanup == LocalAuthorityCleanupResult::AclRestoreFailed) {
		return fail("LOWBOX_ASSIGN_JOB_CLEANUP", L"SetNamedSecurityInfoW(restore)", GetLastError());
	}
	if (cleanup == LocalAuthorityCleanupResult::ProfileDeleteFailed) {
		return fail("LOWBOX_ASSIGN_JOB_PROFILE_DELETE", L"DeleteAppContainerProfile", GetLastError());
	}
	return fail(code, operation, win32);
}

bool terminateAndProveChildTreeDeathBeforeWatcherTransfer(HANDLE jobHandle, HANDLE childHandle,
	DWORD exitCode) {
	const BOOL terminated = TerminateJobObject(jobHandle, exitCode);
	if (!terminated && WaitForSingleObject(childHandle, 0) != WAIT_OBJECT_0) return false;
	return waitForJobTreeDeath(jobHandle, childHandle, LOWBOX_WATCHER_TIMEOUT_MS);
}

int failAfterDurableAuthorityJournal(const char* code, const wchar_t* operation, DWORD win32,
	HANDLE jobHandle, HANDLE childHandle, DWORD exitCode, Profile&, AclScope&) {
	// The durable journal is still Transferring: no watcher owns authority yet. Prove the exact child
	// and job tree dead, then retain this live owner forever. Startup must diagnose rather than infer
	// cleanup authority from process death.
	while (!terminateAndProveChildTreeDeathBeforeWatcherTransfer(jobHandle, childHandle, exitCode)) {
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_CHILD_DEATH_RECOVERY_RETRY\","
			"\"operation\":\"TerminateJobObject/WaitForSingleObject\"}");
		Sleep(LOWBOX_RECOVERY_RETRY_MS);
	}
	writeControl("{\"ok\":false,\"code\":\"" + std::string(code) +
		"\",\"operation\":\"" + jsonEscape(utf8(operation)) + "\",\"win32\":" +
		std::to_string(win32) + ",\"message\":\"" + jsonEscape(utf8(windowsMessage(win32))) +
		"\"}");
	for (;;) Sleep(LOWBOX_RECOVERY_RETRY_MS);
}

void writeControl(const std::string& json) {
	if (controlHandle == INVALID_HANDLE_VALUE) return;
	DWORD written = 0;
	const std::string line = json + "\n";
	WriteFile(controlHandle, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}

int fail(const char* code, const wchar_t* operation, DWORD win32) {
	const std::string json = "{\"ok\":false,\"code\":\"" + std::string(code) +
		"\",\"operation\":\"" + jsonEscape(utf8(operation)) + "\",\"win32\":" +
		std::to_string(win32) + ",\"message\":\"" + jsonEscape(utf8(windowsMessage(win32))) +
		"\"}";
	writeControl(json);
	if (cleanupWatcher != INVALID_HANDLE_VALUE) {
		// Report the failure with an explicit framed request, then observe only. The owner never executes
		// job termination, authority transition, or cleanup after the watcher is armed.
		requestArmedWatcherCancelAndObserve();
	}
	return 125;
}

int fail(const char* code, const wchar_t* operation) {
	return fail(code, operation, GetLastError());
}

bool parseControlFd(const std::wstring& value, HANDLE& handle) {
	wchar_t* end = nullptr;
	const long fd = wcstol(value.c_str(), &end, 10);
	if (!end || *end != L'\0' || fd < 0) return false;
	const intptr_t raw = _get_osfhandle(fd);
	if (raw == -1) return false;
	handle = reinterpret_cast<HANDLE>(raw);
	return true;
}

bool parseInheritedHandle(const std::wstring& value, HANDLE& handle) {
	wchar_t* end = nullptr;
	const unsigned long long raw = wcstoull(value.c_str(), &end, 10);
	if (!end || *end != L'\0' || raw == 0) return false;
	handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(raw));
	return true;
}

bool parseArguments(int argc, wchar_t** argv, HANDLE& control, std::wstring& cwd,
	std::wstring& shell, std::wstring& shellFlag, std::wstring& command, std::wstring& network,
	std::vector<std::wstring>& writable, std::wstring& namespaceValue) {
	if (argc < 2 || std::wstring(argv[1]) != L"spawn") return false;
	for (int i = 2; i < argc; i += 2) {
		if (i + 1 >= argc) return false;
		const std::wstring flag = argv[i];
		const std::wstring value = argv[i + 1];
		if (flag == L"--control-handle") {
			if (!parseControlFd(value, control)) return false;
		} else if (flag == L"--cwd") cwd = value;
		else if (flag == L"--shell") shell = value;
		else if (flag == L"--shell-flag") shellFlag = value;
		else if (flag == L"--command") command = value;
		else if (flag == L"--network") network = value;
		else if (flag == L"--writable") writable.push_back(value);
		else if (flag == L"--test-namespace") namespaceValue = value;
		else return false;
	}
	return control != INVALID_HANDLE_VALUE && !cwd.empty() && !shell.empty() && !shellFlag.empty() &&
		!command.empty() && (network == L"open" || network == L"blocked") && !writable.empty();
}

std::wstring quoteArgument(const std::wstring& value) {
	if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
	std::wstring out = L"\"";
	size_t slashes = 0;
	for (wchar_t ch : value) {
		if (ch == L'\\') {
			++slashes;
			continue;
		}
		if (ch == L'"') {
			out.append(slashes * 2 + 1, L'\\');
			out.push_back(L'"');
			slashes = 0;
			continue;
		}
		out.append(slashes, L'\\');
		slashes = 0;
		out.push_back(ch);
	}
	out.append(slashes * 2, L'\\');
	out.push_back(L'"');
	return out;
}

std::wstring randomProfileName() {
	unsigned char bytes[16]{};
	if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return {};
	static constexpr wchar_t hex[] = L"0123456789abcdef";
	std::wstring name = L"Bound.Lowbox.";
	for (unsigned char byte : bytes) {
		name.push_back(hex[byte >> 4]);
		name.push_back(hex[byte & 15]);
	}
	return name;
}

bool createProfile(Profile& profile) {
	for (int attempt = 0; attempt < 8; ++attempt) {
		profile.name = randomProfileName();
		if (profile.name.empty()) return false;
		HRESULT result = CreateAppContainerProfile(profile.name.c_str(), profile.name.c_str(),
			profile.name.c_str(), nullptr, 0, &profile.sid);
		if (SUCCEEDED(result)) {
			profile.owned = true;
			return true;
		}
		if (HRESULT_CODE(result) != ERROR_ALREADY_EXISTS) {
			SetLastError(HRESULT_CODE(result));
			return false;
		}
	}
	SetLastError(ERROR_ALREADY_EXISTS);
	return false;
}

bool createInternetClientCapability(std::vector<unsigned char>& storage,
	SID_AND_ATTRIBUTES& capability) {
	DWORD size = SECURITY_MAX_SID_SIZE;
	storage.resize(size);
	if (!CreateWellKnownSid(WinCapabilityInternetClientSid, nullptr, storage.data(), &size)) return false;
	capability.Sid = storage.data();
	capability.Attributes = SE_GROUP_ENABLED;
	return true;
}

std::wstring authorityJournalPath(const std::wstring& profileName) {
	wchar_t temp[MAX_PATH]{};
	const DWORD length = GetTempPathW(MAX_PATH, temp);
	if (!length || length >= MAX_PATH) return {};
	const std::wstring namespacePart = testNamespace.empty() ? L"" : L"-" + testNamespace;
	return std::wstring(temp) + L"bound-lowbox" + namespacePart + L"-" + profileName + L".authority";
}

std::wstring authorityJournalPattern(const std::wstring& namespaceValue) {
	wchar_t temp[MAX_PATH]{};
	const DWORD length = GetTempPathW(MAX_PATH, temp);
	if (!length || length >= MAX_PATH) return {};
	const std::wstring namespacePart = namespaceValue.empty() ? L"" : L"-" + namespaceValue;
	return std::wstring(temp) + L"bound-lowbox" + namespacePart + L"-Bound.Lowbox.*.authority";
}

bool writeJournalLine(std::ofstream& journal, const std::wstring& value) {
	journal << utf8(value) << "\n";
	return journal.good();
}

LocalAuthorityCleanupResult restoreMaterializedAuthority(Profile& profile, AclScope& aclScope) {
	for (auto it = aclScope.saved.rbegin(); it != aclScope.saved.rend(); ++it) {
		SavedSecurity& record = **it;
		const SECURITY_INFORMATION daclProtection = record.daclProtected
			? PROTECTED_DACL_SECURITY_INFORMATION
			: UNPROTECTED_DACL_SECURITY_INFORMATION;
		const DWORD status = SetNamedSecurityInfoW(const_cast<LPWSTR>(record.path.c_str()),
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
				daclProtection,
			record.owner, record.group, record.dacl, nullptr);
		if (status != ERROR_SUCCESS) {
			SetLastError(status);
			return LocalAuthorityCleanupResult::AclRestoreFailed;
		}
	}
	aclScope.saved.clear();

	if (profile.owned) {
		const HRESULT deleted = DeleteAppContainerProfile(profile.name.c_str());
		if (FAILED(deleted)) {
			SetLastError(HRESULT_CODE(deleted));
			return LocalAuthorityCleanupResult::ProfileDeleteFailed;
		}
		profile.owned = false;
	}
	return LocalAuthorityCleanupResult::CleanupComplete;
}

[[noreturn]] void retryMaterializedAuthorityRecovery(Profile& profile, AclScope& scope,
	DWORD journalError) {
	// Returning or terminating here would abandon materialized authority without a recoverable
	// journal. Keep this process alive as the authority owner until either checked cleanup succeeds
	// or the complete journal reaches durable storage.
	for (;;) {
		const LocalAuthorityCleanupResult cleanup = restoreMaterializedAuthority(profile, scope);
		if (cleanup == LocalAuthorityCleanupResult::CleanupComplete) {
			writeControl("{\"ok\":false,\"code\":\"LOWBOX_LOCAL_CLEANUP_RECOVERED\","
				"\"operation\":\"authority cleanup retry\",\"journal_win32\":" +
				std::to_string(journalError) + "}");
			ExitProcess(125);
		}

		// This retry path has no child/job handle. It must keep ownership and retry checked local
		// cleanup rather than publishing Recoverable authority without an exact death proof.
		journalError = GetLastError();
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_LOCAL_CLEANUP_RECOVERY_RETRY\","
			"\"operation\":\"authority cleanup and durable journal persistence\","
			"\"journal_win32\":" + std::to_string(journalError) + "}");
		Sleep(LOWBOX_RECOVERY_RETRY_MS);
	}
}

bool persistAuthorityJournal(const Profile& profile, const AclScope& scope,
	std::wstring& journalPath, AuthorityJournalState state, DWORD ownerPid,
	ULONGLONG ownerCreationTime, DWORD watcherPid, ULONGLONG watcherCreationTime,
	DWORD childPid, ULONGLONG childCreationTime, bool jobTreeDeathProof) {
	journalPath = authorityJournalPath(profile.name);
	if (journalPath.empty()) return false;
	const std::wstring partialPath = journalPath + L".partial";
	std::ofstream journal(partialPath, std::ios::binary | std::ios::trunc);
	bool complete = journal &&
		writeJournalLine(journal, AUTHORITY_JOURNAL_VERSION) &&
		writeJournalLine(journal, state == AuthorityJournalState::Transferring ? L"transferring" :
			state == AuthorityJournalState::Active ? L"active" : L"recoverable") &&
		writeJournalLine(journal, std::to_wstring(ownerPid)) &&
		writeJournalLine(journal, std::to_wstring(ownerCreationTime)) &&
		writeJournalLine(journal, std::to_wstring(watcherPid)) &&
		writeJournalLine(journal, std::to_wstring(watcherCreationTime)) &&
		writeJournalLine(journal, std::to_wstring(childPid)) &&
		writeJournalLine(journal, std::to_wstring(childCreationTime)) &&
		writeJournalLine(journal, jobTreeDeathProof ? L"job-tree-dead" : L"unproven") &&
		writeJournalLine(journal, profile.name);
	for (const auto& record : scope.saved) {
		if (!complete) break;
		LPWSTR sddl = nullptr;
		if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(record->descriptor, SDDL_REVISION_1,
			OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &sddl,
			nullptr)) {
			complete = false;
			break;
		}
		complete = writeJournalLine(journal, record->path) && writeJournalLine(journal, sddl);
		LocalFree(sddl);
	}
	journal.flush();
	complete = complete && journal.good();
	journal.close();
	if (complete && MoveFileExW(partialPath.c_str(), journalPath.c_str(),
		MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;

	DeleteFileW(partialPath.c_str());
	return false;
}

bool restoreSecurityFromSddl(const std::wstring& path, const std::wstring& sddl) {
	PSECURITY_DESCRIPTOR descriptor = nullptr;
	if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
		&descriptor, nullptr)) return false;
	PSID owner = nullptr, group = nullptr;
	PACL dacl = nullptr;
	BOOL present = FALSE, defaulted = FALSE;
	GetSecurityDescriptorOwner(descriptor, &owner, &defaulted);
	GetSecurityDescriptorGroup(descriptor, &group, &defaulted);
	GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted);
	const DWORD status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
		OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, owner,
		group, present ? dacl : nullptr, nullptr);
	LocalFree(descriptor);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	return true;
}

bool parseJournalDword(const std::string& text, DWORD& value) {
	if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos) return false;
	errno = 0;
	wchar_t* end = nullptr;
	const std::wstring valueText = wide(text);
	const unsigned long parsed = wcstoul(valueText.c_str(), &end, 10);
	if (errno == ERANGE || !end || *end != L'\0' || parsed > MAXDWORD) return false;
	value = static_cast<DWORD>(parsed);
	return true;
}

bool parseJournalUlonglong(const std::string& text, ULONGLONG& value) {
	if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos) return false;
	errno = 0;
	wchar_t* end = nullptr;
	const std::wstring valueText = wide(text);
	const unsigned long long parsed = _wcstoui64(valueText.c_str(), &end, 10);
	if (errno == ERANGE || !end || *end != L'\0') return false;
	value = static_cast<ULONGLONG>(parsed);
	return true;
}

bool readAuthorityJournal(const std::wstring& path, AuthorityJournal& parsed) {
	std::ifstream journal(path, std::ios::binary);
	if (!journal) return false;
	std::vector<std::string> lines;
	std::string line;
	while (std::getline(journal, line)) lines.push_back(line);
	if (!journal.eof() || lines.empty()) return false;

	const std::string currentVersion = utf8(AUTHORITY_JOURNAL_VERSION);
	const bool versioned = lines[0] == currentVersion;
	const bool legacy = lines[0] == "transferring" || lines[0] == "active" ||
		lines[0] == "recoverable";
	if (!versioned && !legacy) return false;
	const size_t fieldOffset = versioned ? 1 : 0;
	constexpr size_t legacyFieldCount = 9;
	const size_t fieldCount = legacyFieldCount + fieldOffset;
	if (lines.size() < fieldCount || (lines.size() - fieldCount) % 2 != 0) return false;
	AuthorityJournal candidate;
	if (lines[fieldOffset] == "transferring") candidate.state = AuthorityJournalState::Transferring;
	else if (lines[fieldOffset] == "active") candidate.state = AuthorityJournalState::Active;
	else if (lines[fieldOffset] == "recoverable") candidate.state = AuthorityJournalState::Recoverable;
	else return false;
	if (!parseJournalDword(lines[fieldOffset + 1], candidate.ownerPid) ||
		!parseJournalUlonglong(lines[fieldOffset + 2], candidate.ownerCreationTime) ||
		!parseJournalDword(lines[fieldOffset + 3], candidate.watcherPid) ||
		!parseJournalUlonglong(lines[fieldOffset + 4], candidate.watcherCreationTime) ||
		!parseJournalDword(lines[fieldOffset + 5], candidate.childPid) ||
		!parseJournalUlonglong(lines[fieldOffset + 6], candidate.childCreationTime)) return false;
	if (lines[fieldOffset + 7] == "job-tree-dead") candidate.jobTreeDeathProof = true;
	else if (lines[fieldOffset + 7] == "unproven") candidate.jobTreeDeathProof = false;
	else return false;
	if (lines[fieldOffset + 8].empty()) return false;
	candidate.profileName = wide(lines[fieldOffset + 8]);
	for (size_t i = fieldCount; i < lines.size(); ++i) {
		if (lines[i].empty()) return false;
		candidate.authorityLines.push_back(wide(lines[i]));
	}
	if (candidate.authorityLines.size() % 2 != 0) return false;
	parsed = std::move(candidate);
	return true;
}

bool verifyAuthorityJournal(const std::wstring& path) {
	AuthorityJournal parsed;
	return readAuthorityJournal(path, parsed);
}

bool processCreationTime(HANDLE process, ULONGLONG& creationTime) {
	FILETIME creation{}, exit{}, kernel{}, user{};
	if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) return false;
	creationTime = (static_cast<ULONGLONG>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
	return true;
}

std::wstring authorityRecoveryMutexName(const std::wstring& journalPath) {
	ULONGLONG hash = 1469598103934665603ULL;
	for (wchar_t ch : journalPath) {
		hash ^= static_cast<ULONGLONG>(towlower(ch));
		hash *= 1099511628211ULL;
	}
	return L"Local\\Bound.Lowbox.Authority." + std::to_wstring(hash);
}

struct AuthorityRecoveryLock {
	HANDLE value = nullptr;
	bool acquired = false;
	explicit AuthorityRecoveryLock(const std::wstring& journalPath) {
		const std::wstring name = authorityRecoveryMutexName(journalPath);
		value = CreateMutexW(nullptr, FALSE, name.c_str());
		if (!value) return;
		const DWORD wait = WaitForSingleObject(value, INFINITE);
		acquired = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
	}
	void release() {
		if (!acquired) return;
		ReleaseMutex(value);
		acquired = false;
	}
	~AuthorityRecoveryLock() {
		release();
		if (value) CloseHandle(value);
	}
	AuthorityRecoveryLock(const AuthorityRecoveryLock&) = delete;
	AuthorityRecoveryLock& operator=(const AuthorityRecoveryLock&) = delete;
	explicit operator bool() const { return acquired; }
};

bool isProcessIdentityAlive(DWORD pid, ULONGLONG expectedCreationTime) {
	if (pid == 0) return false;
	Handle process;
	process.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!process.value) return false;
	ULONGLONG creationTime = 0;
	return processCreationTime(process.value, creationTime) && creationTime == expectedCreationTime &&
		WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT;
}

const char* staleAuthorityCode(AuthorityJournalState state) {
	return state == AuthorityJournalState::Transferring
		? "LOWBOX_STALE_AUTHORITY_TRANSFERRING"
		: "LOWBOX_STALE_AUTHORITY_ACTIVE";
}

void reportStaleAuthorityDiagnostic(const std::wstring& path, const AuthorityJournal& journal) {
	writeControl("{\"ok\":false,\"code\":\"" + std::string(staleAuthorityCode(journal.state)) +
		"\",\"operation\":\"" + jsonEscape(utf8(path)) + "\",\"owner_pid\":" +
		std::to_string(journal.ownerPid) + ",\"owner_created\":" +
		std::to_string(journal.ownerCreationTime) + ",\"watcher_pid\":" +
		std::to_string(journal.watcherPid) + ",\"watcher_created\":" +
		std::to_string(journal.watcherCreationTime) + "}");
}

bool rewriteAuthorityJournal(const std::wstring& path, const AuthorityJournal& parsed,
	AuthorityJournalState state, DWORD ownerPid, ULONGLONG ownerCreationTime, DWORD watcherPid,
	ULONGLONG watcherCreationTime, DWORD childPid, ULONGLONG childCreationTime,
	bool jobTreeDeathProof) {
	const std::wstring partialPath = path + L".partial";
	std::ofstream journal(partialPath, std::ios::binary | std::ios::trunc);
	bool complete = journal &&
		writeJournalLine(journal, AUTHORITY_JOURNAL_VERSION) &&
		writeJournalLine(journal, state == AuthorityJournalState::Transferring ? L"transferring" :
			state == AuthorityJournalState::Active ? L"active" : L"recoverable") &&
		writeJournalLine(journal, std::to_wstring(ownerPid)) &&
		writeJournalLine(journal, std::to_wstring(ownerCreationTime)) &&
		writeJournalLine(journal, std::to_wstring(watcherPid)) &&
		writeJournalLine(journal, std::to_wstring(watcherCreationTime)) &&
		writeJournalLine(journal, std::to_wstring(childPid)) &&
		writeJournalLine(journal, std::to_wstring(childCreationTime)) &&
		writeJournalLine(journal, jobTreeDeathProof ? L"job-tree-dead" : L"unproven") &&
		writeJournalLine(journal, parsed.profileName);
	for (const auto& value : parsed.authorityLines) complete = complete && writeJournalLine(journal, value);
	journal.flush();
	complete = complete && journal.good();
	journal.close();
	if (complete && MoveFileExW(partialPath.c_str(), path.c_str(),
		MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
	DeleteFileW(partialPath.c_str());
	return false;
}

bool publishAuthorityJournalWatcher(const std::wstring& path, DWORD watcherPid,
	ULONGLONG watcherCreationTime) {
	AuthorityRecoveryLock recoveryLock(path);
	if (!recoveryLock) return false;
	AuthorityJournal parsed;
	if (!readAuthorityJournal(path, parsed) || parsed.state != AuthorityJournalState::Transferring) {
		return false;
	}
	return rewriteAuthorityJournal(path, parsed, AuthorityJournalState::Transferring, parsed.ownerPid,
		parsed.ownerCreationTime, watcherPid, watcherCreationTime, parsed.childPid,
		parsed.childCreationTime, false);
}

bool activateAuthorityJournalWatcher(const std::wstring& path, DWORD watcherPid,
	ULONGLONG watcherCreationTime) {
	AuthorityRecoveryLock recoveryLock(path);
	if (!recoveryLock) return false;
	AuthorityJournal parsed;
	if (!readAuthorityJournal(path, parsed) || parsed.state != AuthorityJournalState::Transferring ||
		parsed.watcherPid != watcherPid || parsed.watcherCreationTime != watcherCreationTime) {
		return false;
	}
	return rewriteAuthorityJournal(path, parsed, AuthorityJournalState::Active, parsed.ownerPid,
		parsed.ownerCreationTime, watcherPid, watcherCreationTime, parsed.childPid,
		parsed.childCreationTime, false);
}

bool restoreAuthorityFromJournalLocked(const std::wstring& path, const AuthorityJournal& parsed) {
	if (!authorityPathMatchesProfile(path, parsed.profileName)) return false;
	for (size_t i = parsed.authorityLines.size(); i >= 2; i -= 2) {
		if (!isAuthorityPathAllowed(parsed.authorityLines[i - 2]) ||
			!restoreSecurityFromSddl(parsed.authorityLines[i - 2], parsed.authorityLines[i - 1])) return false;
	}
	const HRESULT deleted = DeleteAppContainerProfile(parsed.profileName.c_str());
	if (FAILED(deleted) && HRESULT_CODE(deleted) != ERROR_NOT_FOUND) {
		SetLastError(HRESULT_CODE(deleted));
		return false;
	}
	return true;
}

FailedHandoffResolution resolveFailedHandoffJournal(const std::wstring& path,
	const std::wstring& profileName, DWORD ownerPid, ULONGLONG ownerCreationTime, DWORD watcherPid,
	ULONGLONG watcherCreationTime, HANDLE jobHandle, HANDLE childHandle) {
	AuthorityJournal parsed;
	{
		AuthorityRecoveryLock recoveryLock(path);
		if (!recoveryLock) return FailedHandoffResolution::IndeterminateWatcherOwned;
		if (!readAuthorityJournal(path, parsed)) {
			return FailedHandoffResolution::IndeterminateWatcherOwned;
		}
		if (parsed.state == AuthorityJournalState::Active) {
			return FailedHandoffResolution::IndeterminateWatcherOwned;
		}
		if (parsed.state != AuthorityJournalState::Transferring || parsed.ownerPid != ownerPid ||
			parsed.ownerCreationTime != ownerCreationTime || parsed.profileName != profileName ||
			parsed.watcherPid != watcherPid || parsed.watcherCreationTime != watcherCreationTime ||
			parsed.jobTreeDeathProof) {
			return FailedHandoffResolution::IndeterminateWatcherOwned;
		}
		if (rewriteAuthorityJournal(path, parsed, AuthorityJournalState::Transferring,
			ownerPid, ownerCreationTime, 0, 0, parsed.childPid, parsed.childCreationTime, false)) {
			return FailedHandoffResolution::OwnerAuthorityRetained;
		}
	}
	// The reset rewrite can fail after another actor advances the journal. Reacquire the recovery
	// lock and re-read before exercising any parent teardown authority; keep this lock through kill
	// initiation so the watcher cannot publish Active between the decision and TerminateJobObject.
	AuthorityRecoveryLock fallbackLock(path);
	if (!fallbackLock) return FailedHandoffResolution::IndeterminateWatcherOwned;
	AuthorityJournal fresh;
	if (!readAuthorityJournal(path, fresh) || fresh.state == AuthorityJournalState::Active ||
		fresh.state != AuthorityJournalState::Transferring || fresh.ownerPid != ownerPid ||
		fresh.ownerCreationTime != ownerCreationTime || fresh.profileName != profileName ||
		fresh.watcherPid != watcherPid || fresh.watcherCreationTime != watcherCreationTime ||
		fresh.childPid != parsed.childPid || fresh.childCreationTime != parsed.childCreationTime ||
		fresh.jobTreeDeathProof) {
		return FailedHandoffResolution::IndeterminateWatcherOwned;
	}
	parsed = std::move(fresh);
	const BOOL terminated = TerminateJobObject(jobHandle, 125);
	if ((!terminated && WaitForSingleObject(childHandle, 0) != WAIT_OBJECT_0) ||
		!waitForJobTreeDeath(jobHandle, childHandle, LOWBOX_WATCHER_TIMEOUT_MS)) {
		return FailedHandoffResolution::IndeterminateWatcherOwned;
	}
	bool authorityRestored = false;
	for (DWORD attempt = 0; attempt < LOWBOX_FAILED_HANDOFF_RESOLUTION_ATTEMPTS; attempt++) {
		if (!authorityRestored) {
			authorityRestored = restoreAuthorityFromJournalLocked(path, parsed);
		}
		if (authorityRestored &&
			(DeleteFileW(path.c_str()) || GetLastError() == ERROR_FILE_NOT_FOUND)) {
			return FailedHandoffResolution::OwnerTeardownComplete;
		}
		if (attempt + 1 < LOWBOX_FAILED_HANDOFF_RESOLUTION_ATTEMPTS) {
			Sleep(LOWBOX_RECOVERY_RETRY_MS);
		}
	}
	if (!authorityRestored) return FailedHandoffResolution::IndeterminateWatcherOwned;
	// Teardown is complete, so deletion failure must not leave the dead watcher encoded as an
	// authority holder. Persist owner-only Transferring state for a later checked owner retry.
	if (rewriteAuthorityJournal(path, parsed, AuthorityJournalState::Transferring,
		ownerPid, ownerCreationTime, 0, 0, parsed.childPid, parsed.childCreationTime, true)) {
		return FailedHandoffResolution::OwnerAuthorityRetained;
	}
	return FailedHandoffResolution::IndeterminateWatcherOwned;
}

bool markAuthorityJournalRecoverableLocked(const std::wstring& path, DWORD childPid,
	ULONGLONG childCreationTime, bool jobTreeDeathProof) {
	if (!jobTreeDeathProof) return false;
	AuthorityJournal parsed;
	if (!readAuthorityJournal(path, parsed) || parsed.state != AuthorityJournalState::Active ||
		parsed.childPid != childPid || parsed.childCreationTime != childCreationTime) {
		return false;
	}
	return rewriteAuthorityJournal(path, parsed, AuthorityJournalState::Recoverable, 0, 0, 0, 0,
		childPid, childCreationTime, jobTreeDeathProof);
}

bool authorityPathMatchesProfile(const std::wstring& path, const std::wstring& profileName) {
	return !profileName.empty() && path == authorityJournalPath(profileName);
}

bool validateRecoverableAuthorityJournal(const std::wstring& path, const AuthorityJournal& parsed) {
	return parsed.state == AuthorityJournalState::Recoverable && parsed.jobTreeDeathProof &&
		parsed.ownerPid == 0 && parsed.ownerCreationTime == 0 && parsed.watcherPid == 0 &&
		parsed.watcherCreationTime == 0 && parsed.childPid != 0 && parsed.childCreationTime != 0 &&
		authorityPathMatchesProfile(path, parsed.profileName);
}

bool isAuthorityPathAllowed(const std::wstring& path) {
	if (path.empty() || isReparsePoint(path)) return false;
	const DWORD attributes = GetFileAttributesW(path.c_str());
	return attributes != INVALID_FILE_ATTRIBUTES;
}

void reportAuthorityCleanupFailure(const wchar_t*, DWORD win32, HRESULT = S_OK) {
	SetLastError(win32);
}

void captureAuthorityCleanupFailure(AuthorityCleanupFailure* failure, const wchar_t* operation,
	DWORD win32, HRESULT hresult = S_OK) {
	if (failure) {
		failure->operation = operation;
		failure->win32 = win32;
		failure->hresult = hresult;
	}
	reportAuthorityCleanupFailure(operation, win32, hresult);
}

bool cleanupRecoverableAuthorityLocked(const std::wstring& path, const AuthorityJournal& parsed,
	AuthorityCleanupFailure* failure) {
	for (size_t i = parsed.authorityLines.size(); i >= 2; i -= 2) {
		if (!isAuthorityPathAllowed(parsed.authorityLines[i - 2]) ||
			!restoreSecurityFromSddl(parsed.authorityLines[i - 2], parsed.authorityLines[i - 1])) {
			const DWORD error = GetLastError();
			captureAuthorityCleanupFailure(failure, L"restore ACLs", error);
			SetLastError(error);
			return false;
		}
	}
	const HRESULT deleted = DeleteAppContainerProfile(parsed.profileName.c_str());
	if (FAILED(deleted) && HRESULT_CODE(deleted) != ERROR_NOT_FOUND) {
		const DWORD error = HRESULT_CODE(deleted);
		captureAuthorityCleanupFailure(failure, L"DeleteAppContainerProfile", error, deleted);
		SetLastError(error);
		return false;
	}
	if (!DeleteFileW(path.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) {
		const DWORD error = GetLastError();
		captureAuthorityCleanupFailure(failure, L"DeleteFileW(authority journal)", error);
		SetLastError(error);
		return false;
	}
	return true;
}

bool recoverAuthorityJournalLocked(const std::wstring& path) {
	AuthorityJournal parsed;
	if (!readAuthorityJournal(path, parsed)) return false;
	if (!validateRecoverableAuthorityJournal(path, parsed)) return false;
	return cleanupRecoverableAuthorityLocked(path, parsed);
}

bool recoverAuthorityJournal(const std::wstring& path) {
	AuthorityRecoveryLock recoveryLock(path);
	if (!recoveryLock) return false;
	return recoverAuthorityJournalLocked(path);
}

bool recoverStaleAuthority(const std::wstring& namespaceValue) {
	wchar_t temp[MAX_PATH]{};
	const DWORD length = GetTempPathW(MAX_PATH, temp);
	if (!length || length >= MAX_PATH) return false;
	WIN32_FIND_DATAW found{};
	const std::wstring pattern = authorityJournalPattern(namespaceValue);
	if (pattern.empty()) return false;
	FindHandle search;
	search.value = FindFirstFileW(pattern.c_str(), &found);
	if (search.value == INVALID_HANDLE_VALUE) {
		return GetLastError() == ERROR_FILE_NOT_FOUND;
	}
	do {
		const std::wstring path = std::wstring(temp) + found.cFileName;
		AuthorityRecoveryLock recoveryLock(path);
		if (!recoveryLock) return false;
		AuthorityJournal journal;
		if (!readAuthorityJournal(path, journal)) return false;
		if (journal.state != AuthorityJournalState::Recoverable) {
			reportStaleAuthorityDiagnostic(path, journal);
			continue;
		}
		if (!recoverAuthorityJournalLocked(path)) return false;
	} while (FindNextFileW(search.value, &found));
	return GetLastError() == ERROR_NO_MORE_FILES;
}

std::wstring fullPath(const std::wstring& input) {
	DWORD needed = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
	if (!needed) return {};
	std::wstring out(needed, L'\0');
	DWORD written = GetFullPathNameW(input.c_str(), needed, out.data(), nullptr);
	if (!written || written >= needed) return {};
	out.resize(written);
	return out;
}

bool isReparsePoint(const std::wstring& path) {
	DWORD attributes = GetFileAttributesW(path.c_str());
	return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool saveAndApplyAcl(const std::wstring& rawPath, PSID sid, DWORD accessMask, ACCESS_MODE mode,
	DWORD inheritance, AclScope& scope) {
	const std::wstring path = fullPath(rawPath);
	if (path.empty() || isReparsePoint(path)) {
		SetLastError(ERROR_ACCESS_DENIED);
		return false;
	}
	auto record = std::make_unique<SavedSecurity>();
	record->path = path;
	DWORD status = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT,
		OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
		&record->owner, &record->group, &record->dacl, nullptr, &record->descriptor);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	EXPLICIT_ACCESSW entry{};
	entry.grfAccessPermissions = accessMask;
	entry.grfAccessMode = mode;
	entry.grfInheritance = inheritance;
	entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
	entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
	entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
	PACL next = nullptr;
	status = SetEntriesInAclW(1, &entry, record->dacl, &next);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
		DACL_SECURITY_INFORMATION, nullptr, nullptr, next, nullptr);
	LocalFree(next);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	scope.saved.push_back(std::move(record));
	return true;
}

bool containsReparsePoint(const std::wstring& rawPath) {
	const std::wstring path = fullPath(rawPath);
	if (path.empty()) return true;
	const size_t rootLength = path.size() >= 3 && path[1] == L':' && path[2] == L'\\' ? 3 : 0;
	if (rootLength == 0) return true;
	for (size_t end = path.find(L'\\', rootLength);; end = path.find(L'\\', end + 1)) {
		const std::wstring component = end == std::wstring::npos ? path : path.substr(0, end);
		if (isReparsePoint(component)) return true;
		if (end == std::wstring::npos) break;
	}
	return false;
}

bool grantWritableRoot(const std::wstring& root, PSID sid, AclScope& scope) {
	if (containsReparsePoint(root)) {
		SetLastError(ERROR_ACCESS_DENIED);
		return false;
	}
	return saveAndApplyAcl(root, sid,
		FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE, GRANT_ACCESS,
		SUB_CONTAINERS_AND_OBJECTS_INHERIT, scope);
}

bool saveAndProtectGitControlSurface(const std::wstring& rawPath, PSID sid, DWORD inheritance,
	AclScope& scope) {
	const std::wstring path = fullPath(rawPath);
	if (path.empty() || isReparsePoint(path)) {
		SetLastError(ERROR_ACCESS_DENIED);
		return false;
	}
	auto record = std::make_unique<SavedSecurity>();
	record->path = path;
	DWORD status = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT,
		OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
		&record->owner, &record->group, &record->dacl, nullptr, &record->descriptor);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	SECURITY_DESCRIPTOR_CONTROL control{};
	DWORD revision{};
	if (!GetSecurityDescriptorControl(record->descriptor, &control, &revision)) return false;
	record->daclProtected = (control & SE_DACL_PROTECTED) != 0;

	const DWORD explicitReadAceCapacity =
		static_cast<DWORD>(sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid));
	std::vector<unsigned char> aclStorage(record->dacl
		? record->dacl->AclSize + explicitReadAceCapacity
		: sizeof(ACL) + explicitReadAceCapacity);
	PACL filtered = reinterpret_cast<PACL>(aclStorage.data());
	if (!InitializeAcl(filtered, static_cast<DWORD>(aclStorage.size()), ACL_REVISION)) return false;
	for (DWORD index = 0; record->dacl && index < record->dacl->AceCount; ++index) {
		void* rawAce = nullptr;
		if (!GetAce(record->dacl, index, &rawAce)) return false;
		const auto* header = static_cast<ACE_HEADER*>(rawAce);
		PSID aceSid = nullptr;
		if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
			aceSid = reinterpret_cast<PSID>(&static_cast<ACCESS_ALLOWED_ACE*>(rawAce)->SidStart);
		}
		if ((header->AceFlags & INHERITED_ACE) != 0 && aceSid && EqualSid(aceSid, sid)) continue;
		if (!AddAce(filtered, ACL_REVISION, MAXDWORD, rawAce, header->AceSize)) return false;
	}
	EXPLICIT_ACCESSW readEntry{};
	readEntry.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
	readEntry.grfAccessMode = GRANT_ACCESS;
	readEntry.grfInheritance = inheritance;
	readEntry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
	readEntry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
	readEntry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
	PACL protectedDacl = nullptr;
	status = SetEntriesInAclW(1, &readEntry, filtered, &protectedDacl);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	status = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
		DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr,
		protectedDacl, nullptr);
	LocalFree(protectedDacl);
	if (status != ERROR_SUCCESS) {
		SetLastError(status);
		return false;
	}
	scope.saved.push_back(std::move(record));
	return true;
}

bool collectExistingHookDescendants(const std::wstring& directory,
	std::vector<std::pair<std::wstring, bool>>& descendants) {
	WIN32_FIND_DATAW entry{};
	FindHandle search;
	search.value = FindFirstFileW((directory + L"\\*").c_str(), &entry);
	if (search.value == INVALID_HANDLE_VALUE) {
		return GetLastError() == ERROR_FILE_NOT_FOUND;
	}
	do {
		if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
		const std::wstring path = directory + L"\\" + entry.cFileName;
		if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
			SetLastError(ERROR_ACCESS_DENIED);
			return false;
		}
		const bool isDirectory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
		descendants.emplace_back(path, isDirectory);
		if (isDirectory && !collectExistingHookDescendants(path, descendants)) return false;
	} while (FindNextFileW(search.value, &entry));
	return GetLastError() == ERROR_NO_MORE_FILES;
}

bool protectGitControlSurfaces(const std::wstring& root, PSID sid, AclScope& scope) {
	const std::wstring git = fullPath(root + L"\\.git");
	if (git.empty() || GetFileAttributesW(git.c_str()) == INVALID_FILE_ATTRIBUTES) return true;
	const std::wstring config = git + L"\\config";
	if (GetFileAttributesW(config.c_str()) != INVALID_FILE_ATTRIBUTES &&
		!saveAndProtectGitControlSurface(config, sid, NO_INHERITANCE, scope)) return false;
	const std::wstring hooks = git + L"\\hooks";
	const DWORD hooksAttributes = GetFileAttributesW(hooks.c_str());
	if (hooksAttributes != INVALID_FILE_ATTRIBUTES) {
		if ((hooksAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
			SetLastError(ERROR_ACCESS_DENIED);
			return false;
		}
		std::vector<std::pair<std::wstring, bool>> descendants;
		if (!collectExistingHookDescendants(hooks, descendants)) return false;
		if (!saveAndProtectGitControlSurface(hooks, sid, SUB_CONTAINERS_AND_OBJECTS_INHERIT, scope)) {
			return false;
		}
		for (const auto& [path, isDirectory] : descendants) {
			const DWORD inheritance = isDirectory ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
			if (!saveAndProtectGitControlSurface(path, sid, inheritance, scope)) return false;
		}
	}
	return true;
}

bool makePipe(Handle& parentRead, Handle& childWrite) {
	SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
	if (!CreatePipe(&parentRead.value, &childWrite.value, &sa, 0)) return false;
	return SetHandleInformation(parentRead.value, HANDLE_FLAG_INHERIT, 0) != FALSE;
}

struct ForwardContext {
	HANDLE source;
	HANDLE destination;
};

DWORD WINAPI forwardPipe(LPVOID value) {
	std::unique_ptr<ForwardContext> context(static_cast<ForwardContext*>(value));
	char buffer[16 * 1024];
	DWORD read = 0;
	while (ReadFile(context->source, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
		DWORD offset = 0;
		while (offset < read) {
			DWORD written = 0;
			if (!WriteFile(context->destination, buffer + offset, read - offset, &written, nullptr)) return 0;
			offset += written;
		}
	}
	return 0;
}



int reportWatcherFailure(const wchar_t* operation, DWORD win32 = GetLastError()) {
	writeControl("{\"ok\":false,\"code\":\"LOWBOX_WATCHER_RUNTIME\",\"operation\":\"" +
		jsonEscape(utf8(operation)) + "\",\"win32\":" + std::to_string(win32) +
		",\"message\":\"" + jsonEscape(utf8(windowsMessage(win32))) + "\"}");
	return 125;
}

using AuthorityCleanupReporter = void (*)(const wchar_t*, DWORD, HRESULT);

bool closeWatcherLowboxHandles(HANDLE& childHandle, HANDLE& jobHandle,
	AuthorityCleanupReporter reportFailure) {
	bool closed = true;
	if (!CloseHandle(childHandle)) {
		const DWORD error = GetLastError();
		reportFailure(L"close child handle", error, S_OK);
		closed = false;
	}
	childHandle = nullptr;
	if (!CloseHandle(jobHandle)) {
		const DWORD error = GetLastError();
		reportFailure(L"close job handle", error, S_OK);
		closed = false;
	}
	jobHandle = nullptr;
	return closed;
}

int runCleanupWatcher(const std::wstring& journalPath, DWORD ownerPid,
	ULONGLONG expectedOwnerCreationTime, HANDLE jobHandle, HANDLE childHandle, HANDLE controlRead,
	HANDLE reportWrite, HANDLE readyEvent, HANDLE authorityEvent, HANDLE authorityArmedEvent) {
	WatcherTerminalReport report{LOWBOX_WATCHER_REPORT_MAGIC, 125, 1, ERROR_SUCCESS, S_OK, {}};
	auto sendReport = [&]() {
		DWORD written = 0;
		return WriteFile(reportWrite, &report, sizeof(report), &written, nullptr) && written == sizeof(report);
	};
	auto failWatcher = [&](const wchar_t* operation, DWORD win32 = GetLastError(), HRESULT hresult = S_OK) {
		report.cleanupResult = 1;
		report.win32 = win32;
		report.hresult = hresult;
		wcsncpy_s(report.operation, operation, _TRUNCATE);
		sendReport();
		return 125;
	};
	auto failCleanup = [&](const AuthorityCleanupFailure& failure) {
		return failWatcher(failure.operation.c_str(), failure.win32, failure.hresult);
	};
	wchar_t neverArms[2]{};
	if (GetEnvironmentVariableW(L"BOUND_LOWBOX_TEST_WATCHER_NEVER_ARMS", neverArms, 2) > 0) {
		Sleep(LOWBOX_WATCHER_TIMEOUT_MS * 2);
		return failWatcher(L"watcher never arms", ERROR_TIMEOUT);
	}
	Handle owner;
	owner.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, ownerPid);
	if (!owner.value) return failWatcher(L"OpenProcess(owner)");
	ULONGLONG ownerCreationTime = 0;
	if (!processCreationTime(owner.value, ownerCreationTime)) return failWatcher(L"GetProcessTimes(owner)");
	if (ownerCreationTime != expectedOwnerCreationTime) {
		return failWatcher(L"owner creation time validation", ERROR_INVALID_DATA);
	}
	if (!SetEvent(readyEvent)) return failWatcher(L"SetEvent(ready)");
	const DWORD authorityWait = WaitForSingleObject(authorityEvent, INFINITE);
	if (authorityWait != WAIT_OBJECT_0) {
		return failWatcher(L"WaitForSingleObject(authority)",
			authorityWait == WAIT_FAILED ? GetLastError() : ERROR_INVALID_STATE);
	}
	DWORD watcherPid = GetCurrentProcessId();
	ULONGLONG watcherCreationTime = 0;
	if (!processCreationTime(GetCurrentProcess(), watcherCreationTime)) {
		return failWatcher(L"GetProcessTimes(watcher)");
	}
	if (!activateAuthorityJournalWatcher(journalPath, watcherPid, watcherCreationTime)) {
		return failWatcher(L"activateAuthorityJournalWatcher");
	}
	if (!SetEvent(authorityArmedEvent)) return failWatcher(L"SetEvent(authority-armed)");
	HANDLE lifecycleSignals[] = {childHandle, owner.value};
	bool terminateJob = false;
	bool controlPipeOpen = true;
	for (;;) {
		const DWORD lifecycleWait = WaitForMultipleObjects(2, lifecycleSignals, FALSE,
			controlPipeOpen ? 25 : INFINITE);
		if (lifecycleWait == WAIT_OBJECT_0) break;
		if (lifecycleWait == WAIT_OBJECT_0 + 1) {
			terminateJob = true;
			break;
		}
		if (lifecycleWait != WAIT_TIMEOUT) {
			return failWatcher(L"WaitForMultipleObjects(lifecycleSignals)",
				lifecycleWait == WAIT_FAILED ? GetLastError() : ERROR_INVALID_STATE);
		}
		DWORD controlBytes = 0;
		if (!PeekNamedPipe(controlRead, nullptr, 0, nullptr, &controlBytes, nullptr)) {
			const DWORD controlError = GetLastError();
			if (controlError == ERROR_BROKEN_PIPE) {
				controlPipeOpen = false;
				continue;
			}
			return failWatcher(L"PeekNamedPipe(control)", controlError);
		}
		if (controlBytes == 0) continue;
		char controlBuffer[16]{};
		DWORD bytesRead = 0;
		if (!ReadFile(controlRead, controlBuffer, sizeof(controlBuffer), &bytesRead, nullptr)) {
			return failWatcher(L"ReadFile(control)");
		}
		const std::string controlFrame(controlBuffer, bytesRead);
		const char cancelFrame[] = "CANCEL\n";
		if (controlFrame != cancelFrame) {
			return failWatcher(L"ReadFile(control): invalid frame", ERROR_INVALID_DATA);
		}
		terminateJob = true;
		break;
	}
	if (terminateJob && !TerminateJobObject(jobHandle, 125) &&
		WaitForSingleObject(childHandle, 0) != WAIT_OBJECT_0) {
		return failWatcher(L"TerminateJobObject");
	}
	const DWORD childWait = WaitForSingleObject(childHandle, INFINITE);
	if (childWait != WAIT_OBJECT_0) {
		return failWatcher(L"WaitForSingleObject(child)",
			childWait == WAIT_FAILED ? GetLastError() : ERROR_INVALID_STATE);
	}
	if (!GetExitCodeProcess(childHandle, &report.childExitCode)) {
		return failWatcher(L"GetExitCodeProcess(child)");
	}
	if (!waitForJobTreeDeath(jobHandle, childHandle, INFINITE)) return failWatcher(L"waitForJobTreeDeath");
	DWORD childPid = GetProcessId(childHandle);
	ULONGLONG childCreationTime = 0;
	const bool jobTreeDeathProof = childPid != 0 && processCreationTime(childHandle, childCreationTime);
	if (!jobTreeDeathProof) return failWatcher(L"GetProcessTimes(child)");
	AuthorityRecoveryLock recoveryLock(journalPath);
	if (!recoveryLock) return failWatcher(L"AuthorityRecoveryLock");
	if (!markAuthorityJournalRecoverableLocked(journalPath, childPid, childCreationTime,
		jobTreeDeathProof)) return failWatcher(L"markAuthorityJournalRecoverableLocked");
	AuthorityJournal cleanup;
	if (!readAuthorityJournal(journalPath, cleanup)) return failWatcher(L"read authority journal");
	if (!validateRecoverableAuthorityJournal(journalPath, cleanup)) {
		return failWatcher(L"validate authority journal", ERROR_INVALID_DATA);
	}
	if (!closeWatcherLowboxHandles(childHandle, jobHandle, reportAuthorityCleanupFailure)) {
		return failWatcher(L"CloseHandle(lowbox authority)");
	}
	AuthorityCleanupFailure cleanupFailure;
	if (!cleanupRecoverableAuthorityLocked(journalPath, cleanup, &cleanupFailure)) {
		return failCleanup(cleanupFailure);
	}
	report.cleanupResult = 0;
	report.win32 = ERROR_SUCCESS;
	report.hresult = S_OK;
	report.operation[0] = L'\0';
	if (!sendReport()) return 125;
	return 0;
}

WatcherStartResult startCleanupWatcher(const std::wstring& executable, const std::wstring& journalPath,
	const std::wstring& profileName, HANDLE jobHandle, HANDLE childProcess, HANDLE& watcherProcess) {
	AuthorityRecoveryLock transferLock(journalPath);
	if (!transferLock) return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	Handle controlRead;
	Handle controlWrite;
	Handle watcherReportRead;
	Handle watcherReportWrite;
	SECURITY_ATTRIBUTES pipeSecurity{sizeof(pipeSecurity), nullptr, TRUE};
	SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
	if (!CreatePipe(&controlRead.value, &controlWrite.value, &pipeSecurity, 0) ||
		!SetHandleInformation(controlWrite.value, HANDLE_FLAG_INHERIT, 0) ||
		!SetHandleInformation(controlRead.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
		!CreatePipe(&watcherReportRead.value, &watcherReportWrite.value, &pipeSecurity, 0) ||
		!SetHandleInformation(watcherReportRead.value, HANDLE_FLAG_INHERIT, 0) ||
		!SetHandleInformation(watcherReportWrite.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	Handle readyEvent;
	readyEvent.value = CreateEventW(&inherit, TRUE, FALSE, nullptr);
	Handle authorityEvent;
	authorityEvent.value = CreateEventW(&inherit, TRUE, FALSE, nullptr);
	Handle authorityArmedEvent;
	authorityArmedEvent.value = CreateEventW(&inherit, TRUE, FALSE, nullptr);
	if (!readyEvent.value || !authorityEvent.value || !authorityArmedEvent.value) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}

	const DWORD ownerPid = GetCurrentProcessId();
	ULONGLONG ownerCreationTime = 0;
	if (!processCreationTime(GetCurrentProcess(), ownerCreationTime)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	const DWORD childPid = GetProcessId(childProcess);
	ULONGLONG childCreationTime = 0;
	if (childPid == 0 || !processCreationTime(childProcess, childCreationTime)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	Handle inheritedJob;
	Handle inheritedChild;
	if (!DuplicateHandle(GetCurrentProcess(), jobHandle, GetCurrentProcess(), &inheritedJob.value, 0,
		TRUE, DUPLICATE_SAME_ACCESS)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	if (!DuplicateHandle(GetCurrentProcess(), childProcess, GetCurrentProcess(), &inheritedChild.value, 0,
		TRUE, DUPLICATE_SAME_ACCESS)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	std::wstring commandLine = quoteArgument(executable) + L" cleanup-watch --journal " +
		quoteArgument(journalPath) + L" --owner-pid " + std::to_wstring(ownerPid) +
		L" --owner-created " + std::to_wstring(ownerCreationTime) +
		L" --job-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(inheritedJob.value)) +
		L" --child-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(inheritedChild.value)) +
		L" --control-read-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(controlRead.value)) +
		L" --report-write-handle " +
		std::to_wstring(reinterpret_cast<uintptr_t>(watcherReportWrite.value)) +
		L" --ready-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(readyEvent.value)) +
		L" --authority-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(authorityEvent.value)) +
		L" --authority-armed-handle " +
		std::to_wstring(reinterpret_cast<uintptr_t>(authorityArmedEvent.value)) +
		L" --test-namespace " + quoteArgument(testNamespace);

	HANDLE inherited[] = {inheritedJob.value, inheritedChild.value, controlRead.value,
		watcherReportWrite.value, readyEvent.value, authorityEvent.value, authorityArmedEvent.value};
	SIZE_T bytes = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
	AttributeList attributes;
	attributes.value = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
	if (!attributes.value || !InitializeProcThreadAttributeList(attributes.value, 1, 0, &bytes)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
			sizeof(inherited), nullptr, nullptr)) {
		const DWORD error = GetLastError();
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_WATCHER_START\",\"operation\":\"UpdateProcThreadAttribute(watcher handles)\",\"win32\":" +
			std::to_string(error) + "}");
		return {WatcherStartOutcome::FailedPreTransfer, error};
	}
	STARTUPINFOEXW startup{};
	startup.StartupInfo.cb = sizeof(startup);
	startup.lpAttributeList = attributes.value;
	PROCESS_INFORMATION process{};
	if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
		CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &process)) {
		const DWORD error = GetLastError();
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_WATCHER_START\",\"operation\":\"CreateProcessW(cleanup watcher)\",\"win32\":" +
			std::to_string(error) + "}");
		return {WatcherStartOutcome::FailedPreTransfer, error};
	}
	CloseHandle(process.hThread);
	watcherProcess = process.hProcess;
	// The watcher owns these duplicates after CreateProcess succeeds. Closing the parent's copies is
	// required before fixture teardown can prove every authority handle has drained.
	inheritedJob.reset();
	inheritedChild.reset();
	ULONGLONG watcherCreationTime = 0;

	auto cancelPreTransferWatcherAndObserve = [&](DWORD failure) -> WatcherStartResult {
		// ARMED has not been acknowledged. This is launch rollback, not the post-arm CANCEL protocol.
		// The exact watcher must stop before the recovery mutex can normalize or tear down authority.
		TerminateProcess(watcherProcess, 125);
		const DWORD watcherWait = WaitForSingleObject(watcherProcess, LOWBOX_WATCHER_TIMEOUT_MS);
		const bool watcherStopped = watcherWait == WAIT_OBJECT_0;
		FailedHandoffResolution resolution = FailedHandoffResolution::IndeterminateWatcherOwned;
		if (watcherStopped) {
			resolution = resolveFailedHandoffJournal(journalPath, profileName, ownerPid,
				ownerCreationTime, process.dwProcessId, watcherCreationTime, jobHandle, childProcess);
			CloseHandle(watcherProcess);
			watcherProcess = nullptr;
		}
		if (resolution == FailedHandoffResolution::OwnerAuthorityRetained) {
			return {WatcherStartOutcome::FailedPreTransfer, failure};
		}
		if (resolution == FailedHandoffResolution::OwnerTeardownComplete) {
			return {WatcherStartOutcome::FailedPreTransfer, failure};
		}
		return {WatcherStartOutcome::IndeterminateWatcherOwned,
			watcherWait == WAIT_TIMEOUT ? ERROR_TIMEOUT : failure};
	};

	auto requestArmedWatcherCancelAndObserve = [&](DWORD failure) -> WatcherStartResult {
		const char cancelFrame[] = "CANCEL\n";
		DWORD written = 0;
		const bool cancelSent = WriteFile(controlWrite.value, cancelFrame, sizeof(cancelFrame) - 1,
			&written, nullptr) && written == sizeof(cancelFrame) - 1;
		const DWORD cancelError = cancelSent ? ERROR_SUCCESS : GetLastError();
		controlWrite.reset();
		watcherReportWrite.reset();

		WatcherTerminalReport report{};
		DWORD bytesRead = 0;
		const BOOL reportReadCall =
			ReadFile(watcherReportRead.value, &report, sizeof(report), &bytesRead, nullptr);
		const DWORD reportReadError = reportReadCall ? ERROR_SUCCESS : GetLastError();
		const bool reportRead = reportReadCall && bytesRead == sizeof(report) &&
			report.magic == LOWBOX_WATCHER_REPORT_MAGIC;
		watcherReportRead.reset();
		const HANDLE watcherToClose = watcherProcess;
		const BOOL watcherClosed = CloseHandle(watcherToClose);
		const DWORD watcherCloseError = watcherClosed ? ERROR_SUCCESS : GetLastError();
		watcherProcess = INVALID_HANDLE_VALUE;
		const bool watcherClean = reportRead && report.cleanupResult == 0;
		const char* cancelCode = !cancelSent ? "LOWBOX_WATCHER_CANCEL_WRITE_FAILED"
			: !watcherClosed ? "LOWBOX_WATCHER_HANDLE_CLOSE_FAILED"
			: watcherClean ? "LOWBOX_WATCHER_CANCEL_SENT"
			: reportRead ? "LOWBOX_WATCHER_CLEANUP"
			: "LOWBOX_WATCHER_REPORT_FAILED";
		const std::wstring operation = !watcherClosed ? L"CloseHandle(cleanup watcher)"
			: reportRead ? report.operation : L"ReadFile(watcher report)";
		const DWORD diagnosticWin32 = !cancelSent ? cancelError
			: !watcherClosed ? watcherCloseError
			: reportRead ? report.win32
			: reportReadError;
		const HRESULT diagnosticHresult = reportRead ? report.hresult : S_OK;
		writeControl("{\"ok\":false,\"code\":\"" + std::string(cancelCode) +
			"\",\"operation\":\"" + jsonEscape(utf8(operation)) + "\",\"win32\":" +
			std::to_string(diagnosticWin32) + ",\"hresult\":" +
			std::to_string(static_cast<long long>(diagnosticHresult)) + "}");
		return {watcherClean ? WatcherStartOutcome::FailedAfterWatcherCleanup
			: WatcherStartOutcome::IndeterminateWatcherOwned, failure};
	};

	auto observeFailedArmedWait = [&](DWORD failure) -> WatcherStartResult {
		AuthorityRecoveryLock stateLock(journalPath);
		AuthorityJournal journal;
		if (!stateLock || !readAuthorityJournal(journalPath, journal) ||
			journal.watcherPid != process.dwProcessId ||
			journal.watcherCreationTime != watcherCreationTime) {
			stateLock.release();
			return {WatcherStartOutcome::IndeterminateWatcherOwned, failure};
		}
		if (journal.state == AuthorityJournalState::Active) {
			stateLock.release();
			return requestArmedWatcherCancelAndObserve(failure);
		}
		if (journal.state == AuthorityJournalState::Transferring) {
			stateLock.release();
			return cancelPreTransferWatcherAndObserve(failure);
		}
		stateLock.release();
		return {WatcherStartOutcome::IndeterminateWatcherOwned, failure};
	};
	if (!processCreationTime(watcherProcess, watcherCreationTime)) {
		return cancelPreTransferWatcherAndObserve(GetLastError());
	}
	const DWORD readyWait = WaitForSingleObject(readyEvent.value, LOWBOX_WATCHER_TIMEOUT_MS);
	if (readyWait != WAIT_OBJECT_0) {
		const DWORD readyError = readyWait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
		return cancelPreTransferWatcherAndObserve(readyError);
	}
	if (!publishAuthorityJournalWatcher(journalPath, process.dwProcessId, watcherCreationTime)) {
		return cancelPreTransferWatcherAndObserve(GetLastError());
	}
	// The journal remains Transferring while the owner grants authority. Once signaling is attempted,
	// the watcher may durably publish Active even if SetEvent or the ARMED acknowledgement is lost.
	// From that point uncertainty is watcher-owned: request CANCEL and never kill the watcher locally.
	transferLock.release();
	if (!SetEvent(authorityEvent.value)) {
		return requestArmedWatcherCancelAndObserve(GetLastError());
	}
	const DWORD authorityWait =
		WaitForSingleObject(authorityArmedEvent.value, LOWBOX_WATCHER_TIMEOUT_MS);
	if (authorityWait != WAIT_OBJECT_0) {
		const DWORD authorityError = authorityWait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
		return observeFailedArmedWait(authorityError);
	}
	watcherControlWrite = controlWrite.release();
	watcherReportWrite.reset();
	::watcherReportRead = watcherReportRead.release();
	return {WatcherStartOutcome::ConfirmedArmed, ERROR_SUCCESS};
}
int selfTestAuthorityJournal() {
	testNamespace = L"journal-self-test";
	const std::wstring profileName = L"Bound.Lowbox.AuthorityJournalSelfTest";
	const std::wstring path = authorityJournalPath(profileName);
	const std::wstring partialPath = path + L".partial";
	DeleteFileW(path.c_str());
	DeleteFileW(partialPath.c_str());

	const auto journalFieldsMatch = [](const AuthorityJournal& parsed,
		const AuthorityJournal& expected) {
		return parsed.state == expected.state && parsed.ownerPid == expected.ownerPid &&
			parsed.ownerCreationTime == expected.ownerCreationTime &&
			parsed.watcherPid == expected.watcherPid &&
			parsed.watcherCreationTime == expected.watcherCreationTime &&
			parsed.childPid == expected.childPid &&
			parsed.childCreationTime == expected.childCreationTime &&
			parsed.jobTreeDeathProof == expected.jobTreeDeathProof &&
			parsed.profileName == expected.profileName &&
			parsed.authorityLines == expected.authorityLines;
	};
	const auto writeLegacyJournal = [&](const AuthorityJournal& candidate) {
		std::ofstream legacy(path, std::ios::binary | std::ios::trunc);
		bool complete = legacy &&
			writeJournalLine(legacy, candidate.state == AuthorityJournalState::Transferring ? L"transferring" :
				candidate.state == AuthorityJournalState::Active ? L"active" : L"recoverable") &&
			writeJournalLine(legacy, std::to_wstring(candidate.ownerPid)) &&
			writeJournalLine(legacy, std::to_wstring(candidate.ownerCreationTime)) &&
			writeJournalLine(legacy, std::to_wstring(candidate.watcherPid)) &&
			writeJournalLine(legacy, std::to_wstring(candidate.watcherCreationTime)) &&
			writeJournalLine(legacy, std::to_wstring(candidate.childPid)) &&
			writeJournalLine(legacy, std::to_wstring(candidate.childCreationTime)) &&
			writeJournalLine(legacy, candidate.jobTreeDeathProof ? L"job-tree-dead" : L"unproven") &&
			writeJournalLine(legacy, candidate.profileName);
		for (const auto& value : candidate.authorityLines) complete = complete && writeJournalLine(legacy, value);
		legacy.flush();
		return complete && legacy.good();
	};
	const auto writeVersionedJournal = [&](const AuthorityJournal& candidate) {
		return rewriteAuthorityJournal(path, candidate, candidate.state, candidate.ownerPid,
			candidate.ownerCreationTime, candidate.watcherPid, candidate.watcherCreationTime,
			candidate.childPid, candidate.childCreationTime, candidate.jobTreeDeathProof);
	};
	const auto roundTrips = [&](const AuthorityJournal& expected, bool legacy) {
		if (!(legacy ? writeLegacyJournal(expected) : writeVersionedJournal(expected))) return false;
		AuthorityJournal parsed;
		return readAuthorityJournal(path, parsed) && journalFieldsMatch(parsed, expected);
	};

	AuthorityJournal active;
	active.state = AuthorityJournalState::Active;
	active.ownerPid = 41;
	active.ownerCreationTime = 42000000001;
	active.watcherPid = 43;
	active.watcherCreationTime = 44000000002;
	active.childPid = 45;
	active.childCreationTime = 46000000003;
	active.profileName = profileName;
	active.authorityLines = {
		L"C:\\authority-self-test-a", L"D:(A;;FA;;;SY)",
		L"C:\\authority-self-test-b", L"D:(A;;FR;;;SY)",
	};
	AuthorityJournal transferring = active;
	transferring.state = AuthorityJournalState::Transferring;
	transferring.watcherPid = 0;
	transferring.watcherCreationTime = 0;
	AuthorityJournal recoverable = active;
	recoverable.state = AuthorityJournalState::Recoverable;
	recoverable.ownerPid = 0;
	recoverable.ownerCreationTime = 0;
	recoverable.watcherPid = 0;
	recoverable.watcherCreationTime = 0;
	recoverable.jobTreeDeathProof = true;

	int code = 1;
	for (const auto& candidate : {transferring, active, recoverable}) {
		if (!roundTrips(candidate, false)) return code;
		++code;
	}
	const AuthorityJournal legacyTransferring = transferring;
	const AuthorityJournal legacyActive = active;
	const AuthorityJournal legacyRecoverable = recoverable;
	for (const auto& candidate : {legacyTransferring, legacyActive, legacyRecoverable}) {
		if (!roundTrips(candidate, true)) return code;
		++code;
	}

	if (!writeLegacyJournal(active)) return code++;
	AuthorityJournal parsedActive;
	if (!readAuthorityJournal(path, parsedActive) || !journalFieldsMatch(parsedActive, active) ||
		!rewriteAuthorityJournal(path, parsedActive, AuthorityJournalState::Active,
			parsedActive.ownerPid, parsedActive.ownerCreationTime, parsedActive.watcherPid,
			parsedActive.watcherCreationTime, parsedActive.childPid,
			parsedActive.childCreationTime, parsedActive.jobTreeDeathProof)) return code++;
	AuthorityJournal versionedActive;
	if (!readAuthorityJournal(path, versionedActive) ||
		!journalFieldsMatch(versionedActive, active) ||
		!rewriteAuthorityJournal(path, versionedActive, AuthorityJournalState::Recoverable, 0, 0, 0, 0,
			versionedActive.childPid, versionedActive.childCreationTime, true)) return code++;
	AuthorityJournal transitioned;
	if (!readAuthorityJournal(path, transitioned) || !journalFieldsMatch(transitioned, recoverable) ||
		!validateRecoverableAuthorityJournal(path, transitioned) ||
		path != authorityJournalPath(profileName)) return code++;
	const std::wstring parentNamespace = testNamespace;
	testNamespace = L"separate-watcher";
	if (validateRecoverableAuthorityJournal(path, transitioned)) return code++;
	testNamespace = parentNamespace;
	if (!validateRecoverableAuthorityJournal(path, transitioned)) return code++;
	{
		std::ifstream rewritten(path, std::ios::binary);
		std::string versioned((std::istreambuf_iterator<char>(rewritten)),
			std::istreambuf_iterator<char>());
		if (versioned.rfind(utf8(AUTHORITY_JOURNAL_VERSION) + "\n", 0) != 0) return code++;
	}

	if (!writeLegacyJournal(transferring)) return code++;
	AuthorityJournal parsedTransferring;
	if (!readAuthorityJournal(path, parsedTransferring) ||
		!journalFieldsMatch(parsedTransferring, transferring) ||
		!rewriteAuthorityJournal(path, parsedTransferring, AuthorityJournalState::Transferring,
			parsedTransferring.ownerPid, parsedTransferring.ownerCreationTime,
			parsedTransferring.watcherPid, parsedTransferring.watcherCreationTime,
			parsedTransferring.childPid, parsedTransferring.childCreationTime,
			parsedTransferring.jobTreeDeathProof)) return code++;
	AuthorityJournal transitionedTransferring;
	if (!readAuthorityJournal(path, transitionedTransferring) ||
		!journalFieldsMatch(transitionedTransferring, transferring)) return code++;

	auto malformed = recoverable;
	auto rejectsMalformed = [&](const AuthorityJournal& candidate) {
		if (!writeVersionedJournal(candidate)) return false;
		AuthorityJournal reparsed;
		return readAuthorityJournal(path, reparsed) &&
			!validateRecoverableAuthorityJournal(path, reparsed);
	};
	malformed.state = AuthorityJournalState::Active;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.jobTreeDeathProof = false;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.ownerPid = 1;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.ownerCreationTime = 1;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.watcherPid = 1;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.watcherCreationTime = 1;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.childPid = 0;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.childCreationTime = 0;
	if (!rejectsMalformed(malformed)) return code++;
	malformed = recoverable;
	malformed.profileName += L".forged";
	if (!rejectsMalformed(malformed)) return code++;
	if (validateRecoverableAuthorityJournal(path + L".forged", recoverable)) return code++;

	if (!writeVersionedJournal(recoverable)) return code++;
	{
		std::ifstream current(path, std::ios::binary);
		std::string validBody((std::istreambuf_iterator<char>(current)),
			std::istreambuf_iterator<char>());
		const std::string currentVersion = utf8(AUTHORITY_JOURNAL_VERSION) + "\n";
		if (validBody.rfind(currentVersion, 0) != 0) return code++;
		std::ofstream unknownVersion(path, std::ios::binary | std::ios::trunc);
		unknownVersion << "bound-lowbox-authority-v2\n"
			<< validBody.substr(currentVersion.size());
	}
	AuthorityJournal unknownVersion;
	if (readAuthorityJournal(path, unknownVersion)) return code++;
	if (!writeVersionedJournal(recoverable)) return code++;
	{
		std::ifstream current(path, std::ios::binary);
		std::string negativeNumber((std::istreambuf_iterator<char>(current)),
			std::istreambuf_iterator<char>());
		const std::string ownerPid = "recoverable\n0\n";
		const size_t ownerPidOffset = negativeNumber.find(ownerPid);
		if (ownerPidOffset == std::string::npos) return code++;
		negativeNumber.replace(ownerPidOffset, ownerPid.size(), "recoverable\n-1\n");
		std::ofstream malformedNumber(path, std::ios::binary | std::ios::trunc);
		malformedNumber << negativeNumber;
	}
	AuthorityJournal negativeNumber;
	if (readAuthorityJournal(path, negativeNumber)) return code++;
	if (!writeVersionedJournal(recoverable)) return code++;
	{
		std::ifstream current(path, std::ios::binary);
		std::string overflowNumber((std::istreambuf_iterator<char>(current)),
			std::istreambuf_iterator<char>());
		const std::string childPid = "\n" + std::to_string(recoverable.childPid) + "\n";
		const size_t childPidOffset = overflowNumber.find(childPid);
		if (childPidOffset == std::string::npos) return code++;
		overflowNumber.replace(childPidOffset, childPid.size(), "\n4294967296\n");
		std::ofstream malformedNumber(path, std::ios::binary | std::ios::trunc);
		malformedNumber << overflowNumber;
	}
	AuthorityJournal overflowNumber;
	if (readAuthorityJournal(path, overflowNumber)) return code++;
	{
		std::ofstream truncated(path, std::ios::binary | std::ios::trunc);
		truncated << "recoverable\n0\n0\n0\n0\n";
	}
	AuthorityJournal truncated;
	if (readAuthorityJournal(path, truncated)) return code++;
	if (!writeVersionedJournal(recoverable)) return code++;
	{
		std::ofstream extra(path, std::ios::binary | std::ios::app);
		extra << "forged-extra-line\n";
	}
	AuthorityJournal malformedSchema;
	if (readAuthorityJournal(path, malformedSchema)) return code++;

	DeleteFileW(path.c_str());
	DeleteFileW(partialPath.c_str());
	std::cout << "{\"ok\":true}" << std::endl;
	return 0;
}

int inspectCleanupFatal(const wchar_t* phase, unsigned long status) {
	std::wcerr << L"inspect-cleanup phase=" << phase << L" status=" << status << std::endl;
	writeControl("{\"ok\":false,\"code\":\"LOWBOX_INSPECT_CLEANUP_FAILED\",\"phase\":\"" +
		jsonEscape(utf8(phase)) + "\",\"status\":" + std::to_string(status) + "}");
	return 125;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
	if (argc == 2 && std::wstring(argv[1]) == L"self-test-authority-journal") {
		return selfTestAuthorityJournal();
	}
	if ((argc == 6 || argc == 8) && std::wstring(argv[1]) == L"inspect-cleanup" &&
		std::wstring(argv[2]) == L"--profile" && std::wstring(argv[4]) == L"--path" &&
		(argc == 6 || std::wstring(argv[6]) == L"--test-namespace")) {
		const std::wstring profileName = argv[3];
		if (argc == 8) testNamespace = argv[7];
		// Registration is represented by the per-SID AppContainer mapping under HKCU. SID
		// derivation alone is deterministic and therefore cannot answer whether the profile exists.
		PSID profileSid = nullptr;
		const HRESULT derived = DeriveAppContainerSidFromAppContainerName(profileName.c_str(), &profileSid);
		if (FAILED(derived) || !profileSid) {
			const DWORD derivedStatus = FAILED(derived) && HRESULT_FACILITY(derived) == FACILITY_WIN32
				? HRESULT_CODE(derived)
				: (FAILED(derived) ? static_cast<DWORD>(derived) : ERROR_INVALID_SID);
			return inspectCleanupFatal(L"DeriveAppContainerSidFromAppContainerName", derivedStatus);
		}
		LPWSTR profileSidString = nullptr;
		if (!ConvertSidToStringSidW(profileSid, &profileSidString) || !profileSidString) {
			const DWORD sidStringError = GetLastError();
			FreeSid(profileSid);
			return inspectCleanupFatal(L"ConvertSidToStringSidW", sidStringError);
		}
		const std::wstring profileMappingPath =
			L"Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\" +
			std::wstring(profileSidString);
		LocalFree(profileSidString);
		HKEY profileKey = nullptr;
		const LSTATUS profileStatus = RegOpenKeyExW(HKEY_CURRENT_USER, profileMappingPath.c_str(), 0,
			KEY_READ, &profileKey);
		const bool profileExists = profileStatus == ERROR_SUCCESS;
		if (profileKey) RegCloseKey(profileKey);
		if (!profileExists && profileStatus != ERROR_FILE_NOT_FOUND &&
			profileStatus != ERROR_PATH_NOT_FOUND) {
			FreeSid(profileSid);
			return inspectCleanupFatal(L"RegOpenKeyExW(profile mapping)", profileStatus);
		}


		bool lowboxAce = false;
		PSECURITY_DESCRIPTOR descriptor = nullptr;
		PACL dacl = nullptr;
		const DWORD aclStatus = GetNamedSecurityInfoW(argv[5], SE_FILE_OBJECT,
			DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &descriptor);
		if (aclStatus != ERROR_SUCCESS) {
			FreeSid(profileSid);
			return inspectCleanupFatal(L"GetNamedSecurityInfoW", aclStatus);
		}
		for (DWORD index = 0; dacl && index < dacl->AceCount; ++index) {
			void* rawAce = nullptr;
			if (!GetAce(dacl, index, &rawAce)) continue;
			const auto* header = static_cast<ACE_HEADER*>(rawAce);
			PSID sid = nullptr;
			if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
				sid = reinterpret_cast<PSID>(&static_cast<ACCESS_ALLOWED_ACE*>(rawAce)->SidStart);
			} else if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
				sid = reinterpret_cast<PSID>(&static_cast<ACCESS_DENIED_ACE*>(rawAce)->SidStart);
			}
			if (sid && IsValidSid(sid) && *GetSidSubAuthorityCount(sid) >= 2 &&
				*GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID &&
				*GetSidSubAuthority(sid, 1) == SECURITY_APP_PACKAGE_RID_COUNT) {
				lowboxAce = true;
				break;
			}
		}
		if (descriptor) LocalFree(descriptor);
		FreeSid(profileSid);
		const bool journalExists = GetFileAttributesW(authorityJournalPath(profileName).c_str()) !=
			INVALID_FILE_ATTRIBUTES;
		std::cout << "{\"Journal\":" << (journalExists ? "true" : "false")
			<< ",\"Profile\":" << (profileExists ? "true" : "false")
			<< ",\"LowboxAces\":" << (lowboxAce ? 1 : 0) << "}" << std::endl;
		return 0;
	}
	if (argc == 24 && std::wstring(argv[1]) == L"cleanup-watch" &&
		std::wstring(argv[2]) == L"--journal" && std::wstring(argv[4]) == L"--owner-pid" &&
		std::wstring(argv[6]) == L"--owner-created" &&
		std::wstring(argv[8]) == L"--job-handle" &&
		std::wstring(argv[10]) == L"--child-handle" &&
		std::wstring(argv[12]) == L"--control-read-handle" &&
		std::wstring(argv[14]) == L"--report-write-handle" &&
		std::wstring(argv[16]) == L"--ready-handle" &&
		std::wstring(argv[18]) == L"--authority-handle" &&
		std::wstring(argv[20]) == L"--authority-armed-handle" &&
		std::wstring(argv[22]) == L"--test-namespace") {
		testNamespace = argv[23];
		HANDLE job = INVALID_HANDLE_VALUE, child = INVALID_HANDLE_VALUE;
		HANDLE controlRead = INVALID_HANDLE_VALUE, reportWrite = INVALID_HANDLE_VALUE;
		HANDLE ready = INVALID_HANDLE_VALUE, authority = INVALID_HANDLE_VALUE;
		HANDLE authorityArmed = INVALID_HANDLE_VALUE;
		if (!parseInheritedHandle(argv[9], job) || !parseInheritedHandle(argv[11], child) ||
			!parseInheritedHandle(argv[13], controlRead) || !parseInheritedHandle(argv[15], reportWrite) ||
			!parseInheritedHandle(argv[17], ready) || !parseInheritedHandle(argv[19], authority) ||
			!parseInheritedHandle(argv[21], authorityArmed)) return 125;
		return runCleanupWatcher(argv[3], wcstoul(argv[5], nullptr, 10),
			_wcstoui64(argv[7], nullptr, 10), job, child, controlRead, reportWrite, ready, authority,
			authorityArmed);
	}

	std::wstring cwd, shell, shellFlag, command, network;
	std::vector<std::wstring> writable;
	if (!parseArguments(argc, argv, controlHandle, cwd, shell, shellFlag, command, network, writable,
		testNamespace)) {
		return 125;
	}
	if (!recoverStaleAuthority(testNamespace)) {
		return fail("LOWBOX_STALE_AUTHORITY", L"recoverAuthorityJournal");
	}

	Profile profile;
	if (!createProfile(profile)) return fail("LOWBOX_PROFILE", L"CreateAppContainerProfile");

	AclScope aclScope;
	for (const auto& root : writable) {
		if (!grantWritableRoot(root, profile.sid, aclScope)) {
			const DWORD win32 = GetLastError();
			return failAfterCheckedLocalAuthorityCleanup("LOWBOX_ACL", L"SetNamedSecurityInfoW", win32,
				profile, aclScope);
		}
	}
	for (const auto& root : writable) {
		if (!protectGitControlSurfaces(root, profile.sid, aclScope)) {
			const DWORD win32 = GetLastError();
			return failAfterCheckedLocalAuthorityCleanup("LOWBOX_GIT_ACL",
				L"SetNamedSecurityInfoW(.git)", win32, profile, aclScope);
		}
	}

	Handle stdoutRead, stdoutWrite, stderrRead, stderrWrite, stdinNull;
	if (!makePipe(stdoutRead, stdoutWrite) || !makePipe(stderrRead, stderrWrite)) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_PIPE", L"CreatePipe", win32, profile,
			aclScope);
	}
	SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
	stdinNull.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit,
		OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (stdinNull.value == INVALID_HANDLE_VALUE) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_PIPE", L"CreateFileW(NUL)", win32,
			profile, aclScope);
	}

	SECURITY_CAPABILITIES capabilities{};
	capabilities.AppContainerSid = profile.sid;
	std::vector<unsigned char> internetClientSid;
	SID_AND_ATTRIBUTES internetClient{};
	if (network == L"open") {
		if (!createInternetClientCapability(internetClientSid, internetClient)) {
			const DWORD win32 = GetLastError();
			return failAfterCheckedLocalAuthorityCleanup("LOWBOX_CAPABILITY",
				L"CreateWellKnownSid(WinCapabilityInternetClientSid)", win32, profile, aclScope);
		}
		capabilities.Capabilities = &internetClient;
		capabilities.CapabilityCount = 1;
	}
	HANDLE inherited[] = {stdinNull.value, stdoutWrite.value, stderrWrite.value};
	SIZE_T bytes = 0;
	InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
	AttributeList attributes;
	attributes.value = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
	if (!attributes.value || !InitializeProcThreadAttributeList(attributes.value, 2, 0, &bytes)) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_ATTRIBUTES",
			L"InitializeProcThreadAttributeList", win32, profile, aclScope);
	}
	if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
		&capabilities, sizeof(capabilities), nullptr, nullptr) ||
		!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
			sizeof(inherited), nullptr, nullptr)) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_ATTRIBUTES", L"UpdateProcThreadAttribute",
			win32, profile, aclScope);
	}

	STARTUPINFOEXW startup{};
	startup.StartupInfo.cb = sizeof(startup);
	startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	startup.StartupInfo.hStdInput = stdinNull.value;
	startup.StartupInfo.hStdOutput = stdoutWrite.value;
	startup.StartupInfo.hStdError = stderrWrite.value;
	startup.lpAttributeList = attributes.value;

	Handle job;
	job.value = CreateJobObjectW(nullptr, nullptr);
	if (!job.value) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_JOB", L"CreateJobObjectW", win32, profile,
			aclScope);
	}
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
	if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
		sizeof(limits))) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_JOB", L"SetInformationJobObject", win32,
			profile, aclScope);
	}

	std::wstring commandLine = quoteArgument(shell) + L" " + quoteArgument(shellFlag) + L" " + quoteArgument(command);
	PROCESS_INFORMATION process{};
	if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE,
		EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr,
		cwd.c_str(), &startup.StartupInfo, &process)) {
		const DWORD win32 = GetLastError();
		return failAfterCheckedLocalAuthorityCleanup("LOWBOX_CREATE_PROCESS", L"CreateProcessW", win32,
			profile, aclScope);
	}
	Handle childProcess;
	childProcess.value = process.hProcess;
	Handle childThread;
	childThread.value = process.hThread;
	if (!AssignProcessToJobObject(job.value, childProcess.value)) {
		const DWORD win32 = GetLastError();
		return cleanupAuthorityAfterUncontainedSuspendedChildDeath(childProcess.value, 125,
			"LOWBOX_ASSIGN_JOB", L"AssignProcessToJobObject", win32, profile, aclScope);
	}

	ULONGLONG ownerCreationTime = 0;
	if (!processCreationTime(GetCurrentProcess(), ownerCreationTime)) {
		const DWORD win32 = GetLastError();
		return cleanupAuthorityAfterUncontainedSuspendedChildDeath(childProcess.value, 125,
			"LOWBOX_OWNER_IDENTITY", L"GetProcessTimes", win32, profile, aclScope);
	}
	DWORD childPid = GetProcessId(childProcess.value);
	ULONGLONG childCreationTime = 0;
	if (childPid == 0 || !processCreationTime(childProcess.value, childCreationTime)) {
		const DWORD win32 = GetLastError();
		return cleanupAuthorityAfterUncontainedSuspendedChildDeath(childProcess.value, 125,
			"LOWBOX_CHILD_IDENTITY", L"GetProcessTimes", win32, profile, aclScope);
	}
	std::wstring journalPath;
	if (!persistAuthorityJournal(profile, aclScope, journalPath, AuthorityJournalState::Transferring,
		GetCurrentProcessId(), ownerCreationTime, 0, 0, childPid, childCreationTime, false)) {
		const DWORD win32 = GetLastError();
		return failAfterDurableAuthorityJournal("LOWBOX_CLEANUP_JOURNAL", L"persistAuthorityJournal",
			win32, job.value, childProcess.value, 125, profile, aclScope);
	}
	wchar_t executable[MAX_PATH]{};
	if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) {
		const DWORD win32 = GetLastError();
		return failAfterDurableAuthorityJournal("LOWBOX_WATCHER", L"GetModuleFileNameW", win32,
			job.value, childProcess.value, 125, profile, aclScope);
	}
	cleanupJournalPath = journalPath;
	const WatcherStartResult watcherStart =
		startCleanupWatcher(executable, journalPath, profile.name, job.value, childProcess.value,
			cleanupWatcher);
	if (watcherStart.outcome == WatcherStartOutcome::FailedPreTransfer) {
		return failAfterDurableAuthorityJournal("LOWBOX_WATCHER", L"startCleanupWatcher",
			watcherStart.win32, job.value, childProcess.value, 125, profile, aclScope);
	}
	if (watcherStart.outcome == WatcherStartOutcome::FailedAfterWatcherCleanup) {
		return fail("LOWBOX_WATCHER", L"startCleanupWatcher", watcherStart.win32);
	}
	if (watcherStart.outcome == WatcherStartOutcome::IndeterminateWatcherOwned) {
		return failWithoutAuthorityMutation("LOWBOX_WATCHER_INDETERMINATE", L"startCleanupWatcher",
			watcherStart.win32);
	}
	if (watcherStart.outcome != WatcherStartOutcome::ConfirmedArmed) {
		return failWithoutAuthorityMutation("LOWBOX_WATCHER_INVALID_OUTCOME", L"startCleanupWatcher",
			ERROR_INVALID_STATE);
	}
	// ConfirmedArmed transfers practical ownership completely. The watcher already holds duplicate
	// handles and reports terminal status; the owner must not retain handles that block profile deletion.
	childProcess.reset();
	job.reset();
	wchar_t failAfterWatcher[2]{};
	if (GetEnvironmentVariableW(L"BOUND_LOWBOX_TEST_FAIL_AFTER_WATCHER", failAfterWatcher, 2) > 0) {
		writeControl("{\"ok\":true,\"pid\":" + std::to_string(process.dwProcessId) +
			",\"profile\":\"" + jsonEscape(utf8(profile.name)) + "\"}");
		Sleep(250);
		requestArmedWatcherCancelAndObserve();
	}

	stdoutWrite.reset();
	stderrWrite.reset();
	Handle stdoutThread, stderrThread;
	auto* stdoutContext = new ForwardContext{stdoutRead.value, GetStdHandle(STD_OUTPUT_HANDLE)};
	stdoutThread.value = CreateThread(nullptr, 0, forwardPipe, stdoutContext, 0, nullptr);
	if (!stdoutThread.value) delete stdoutContext;
	auto* stderrContext = new ForwardContext{stderrRead.value, GetStdHandle(STD_ERROR_HANDLE)};
	stderrThread.value = CreateThread(nullptr, 0, forwardPipe, stderrContext, 0, nullptr);
	if (!stderrThread.value) delete stderrContext;
	if (!stdoutThread.value || !stderrThread.value) {
		const DWORD win32 = GetLastError();
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_FORWARD\",\"operation\":\"CreateThread\",\"win32\":" +
			std::to_string(win32) + ",\"message\":\"" + jsonEscape(utf8(windowsMessage(win32))) + "\"}");
		requestArmedWatcherCancelAndObserve();
	}

	if (ResumeThread(childThread.value) == static_cast<DWORD>(-1)) {
		const DWORD win32 = GetLastError();
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_RESUME\",\"operation\":\"ResumeThread\",\"win32\":" +
			std::to_string(win32) + ",\"message\":\"" + jsonEscape(utf8(windowsMessage(win32))) + "\"}");
		requestArmedWatcherCancelAndObserve();
	}
	childThread.reset();
	writeControl("{\"ok\":true,\"pid\":" + std::to_string(process.dwProcessId) +
		",\"profile\":\"" + jsonEscape(utf8(profile.name)) + "\"}");

	WatcherTerminalReport report{};
	const WatcherTerminalStatus watcherStatus = awaitArmedWatcherTerminalStatus(report);
	if (watcherStatus == WatcherTerminalStatus::CleanupFailed) {
		writeControl("{\"ok\":false,\"code\":\"LOWBOX_WATCHER_CLEANUP\",\"operation\":\"" +
			jsonEscape(utf8(report.operation)) + "\",\"win32\":" + std::to_string(report.win32) +
			",\"hresult\":" + std::to_string(report.hresult) + "}");
	}
	if (watcherStatus != WatcherTerminalStatus::CleanupComplete) reportArmedWatcherAbnormalExit();
	WaitForSingleObject(stdoutThread.value, INFINITE);
	WaitForSingleObject(stderrThread.value, INFINITE);
	return static_cast<int>(report.childExitCode);
}
