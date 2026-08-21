#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <io.h>
#include <algorithm>
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
HANDLE cleanupWatcher = nullptr;
HANDLE watcherControlWrite = nullptr;
std::wstring cleanupJournalPath;
constexpr DWORD LOWBOX_WATCHER_TIMEOUT_MS = 5000;
constexpr DWORD LOWBOX_RECOVERY_RETRY_MS = 1000;

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

std::wstring authorityJournalPath(const std::wstring& profileName);
bool verifyAuthorityJournal(const std::wstring& path);
bool publishAuthorityJournalWatcher(const std::wstring& path, DWORD watcherPid,
	ULONGLONG watcherCreationTime);
bool resetAuthorityJournalAfterFailedHandoff(const std::wstring& path, DWORD watcherPid,
	ULONGLONG watcherCreationTime);
bool markAuthorityJournalRecoverableLocked(const std::wstring& path, DWORD childPid,
	ULONGLONG childCreationTime, bool jobTreeDeathProof);
bool recoverAuthorityJournalLocked(const std::wstring& path);
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
	WatcherAbnormalExit,
};

enum class WatcherStartOutcome {
	ConfirmedArmed,
	FailedPreTransfer,
	IndeterminateWatcherOwned,
};

struct WatcherStartResult {
	WatcherStartOutcome outcome;
	DWORD win32;
};

WatcherTerminalStatus awaitArmedWatcherTerminalStatus() {
	if (cleanupWatcher == nullptr) return WatcherTerminalStatus::WatcherAbnormalExit;
	// After authority is armed, the watcher owns termination and cleanup. The owner may wait
	// without a deadline: a slow cleanup is not a failed command, and timing out cannot transfer
	// authority back to the owner.
	const DWORD wait = WaitForSingleObject(cleanupWatcher, INFINITE);
	if (wait != WAIT_OBJECT_0) return WatcherTerminalStatus::WatcherAbnormalExit;
	DWORD watcherExitCode = 125;
	if (!GetExitCodeProcess(cleanupWatcher, &watcherExitCode) || watcherExitCode != 0) {
		return WatcherTerminalStatus::WatcherAbnormalExit;
	}
	CloseHandle(cleanupWatcher);
	cleanupWatcher = nullptr;
	if (watcherControlWrite != nullptr) CloseHandle(watcherControlWrite);
	watcherControlWrite = nullptr;
	cleanupJournalPath.clear();
	return WatcherTerminalStatus::CleanupComplete;
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
}

void observeIndeterminateWatcherBoundedly() {
	if (cleanupWatcher == nullptr) return;
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
	// A failed or late request does not return authority to the owner. The watcher holds an exact owner
	// process handle, detects owner death independently, and remains the sole lifecycle/cleanup executor.
	const WatcherTerminalStatus status = awaitArmedWatcherTerminalStatus();
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
	if (cleanupWatcher != nullptr) {
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
	std::vector<std::wstring>& writable) {
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
	return std::wstring(temp) + L"bound-lowbox-" + profileName + L".authority";
}

bool writeJournalLine(std::ofstream& journal, const std::wstring& value) {
	journal << utf8(value) << "\n";
	return journal.good();
}

LocalAuthorityCleanupResult restoreMaterializedAuthority(Profile& profile, AclScope& aclScope) {
	for (auto it = aclScope.saved.rbegin(); it != aclScope.saved.rend(); ++it) {
		SavedSecurity& record = **it;
		const DWORD status = SetNamedSecurityInfoW(const_cast<LPWSTR>(record.path.c_str()),
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
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

bool readAuthorityJournal(const std::wstring& path, AuthorityJournal& parsed) {
	std::ifstream journal(path, std::ios::binary);
	if (!journal) return false;
	std::vector<std::string> lines;
	std::string line;
	while (std::getline(journal, line)) lines.push_back(line);
	if (!journal.eof() || lines.size() < 9 || lines.size() % 2 == 0) return false;
	if (lines[0] == "transferring") parsed.state = AuthorityJournalState::Transferring;
	else if (lines[0] == "active") parsed.state = AuthorityJournalState::Active;
	else if (lines[0] == "recoverable") parsed.state = AuthorityJournalState::Recoverable;
	else return false;
	wchar_t* end = nullptr;
	parsed.ownerPid = wcstoul(wide(lines[1]).c_str(), &end, 10);
	if (!end || *end != L'\0') return false;
	end = nullptr;
	parsed.ownerCreationTime = _wcstoui64(wide(lines[2]).c_str(), &end, 10);
	if (!end || *end != L'\0') return false;
	end = nullptr;
	parsed.watcherPid = wcstoul(wide(lines[3]).c_str(), &end, 10);
	if (!end || *end != L'\0') return false;
	end = nullptr;
	parsed.watcherCreationTime = _wcstoui64(wide(lines[4]).c_str(), &end, 10);
	if (!end || *end != L'\0') return false;
	end = nullptr;
	parsed.childPid = wcstoul(wide(lines[5]).c_str(), &end, 10);
	if (!end || *end != L'\0') return false;
	end = nullptr;
	parsed.childCreationTime = _wcstoui64(wide(lines[6]).c_str(), &end, 10);
	if (!end || *end != L'\0') return false;
	if (lines[7] == "job-tree-dead") parsed.jobTreeDeathProof = true;
	else if (lines[7] == "unproven") parsed.jobTreeDeathProof = false;
	else return false;
	if (lines[8].empty()) return false;
	parsed.profileName = wide(lines[8]);
	for (size_t i = 9; i < lines.size(); ++i) {
		if (lines[i].empty()) return false;
		parsed.authorityLines.push_back(wide(lines[i]));
	}
	return parsed.authorityLines.size() % 2 == 0;
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

bool resetAuthorityJournalAfterFailedHandoff(const std::wstring& path, DWORD watcherPid,
	ULONGLONG watcherCreationTime) {
	AuthorityRecoveryLock recoveryLock(path);
	if (!recoveryLock) return false;
	AuthorityJournal parsed;
	if (!readAuthorityJournal(path, parsed) ||
		parsed.state != AuthorityJournalState::Transferring ||
		parsed.watcherPid != watcherPid || parsed.watcherCreationTime != watcherCreationTime ||
		parsed.jobTreeDeathProof) {
		return false;
	}
	return rewriteAuthorityJournal(path, parsed, AuthorityJournalState::Transferring,
		parsed.ownerPid, parsed.ownerCreationTime, 0, 0, parsed.childPid,
		parsed.childCreationTime, false);
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

bool isAuthorityPathAllowed(const std::wstring& path) {
	if (path.empty() || isReparsePoint(path)) return false;
	const DWORD attributes = GetFileAttributesW(path.c_str());
	return attributes != INVALID_FILE_ATTRIBUTES;
}

bool recoverAuthorityJournalLocked(const std::wstring& path) {
	AuthorityJournal parsed;
	if (!readAuthorityJournal(path, parsed)) return false;
	if (parsed.state != AuthorityJournalState::Recoverable || !parsed.jobTreeDeathProof ||
		parsed.ownerPid != 0 || parsed.ownerCreationTime != 0 || parsed.watcherPid != 0 ||
		parsed.watcherCreationTime != 0 || parsed.childPid == 0 || parsed.childCreationTime == 0 ||
		!authorityPathMatchesProfile(path, parsed.profileName)) return false;
	for (size_t i = parsed.authorityLines.size(); i >= 2; i -= 2) {
		if (!isAuthorityPathAllowed(parsed.authorityLines[i - 2]) ||
			!restoreSecurityFromSddl(parsed.authorityLines[i - 2], parsed.authorityLines[i - 1])) return false;
	}
	const HRESULT deleted = DeleteAppContainerProfile(parsed.profileName.c_str());
	if (FAILED(deleted) && HRESULT_CODE(deleted) != ERROR_NOT_FOUND) {
		SetLastError(HRESULT_CODE(deleted));
		return false;
	}
	if (!DeleteFileW(path.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) return false;
	return true;
}

bool recoverAuthorityJournal(const std::wstring& path) {
	AuthorityRecoveryLock recoveryLock(path);
	if (!recoveryLock) return false;
	return recoverAuthorityJournalLocked(path);
}

bool recoverStaleAuthority() {
	wchar_t temp[MAX_PATH]{};
	const DWORD length = GetTempPathW(MAX_PATH, temp);
	if (!length || length >= MAX_PATH) return false;
	WIN32_FIND_DATAW found{};
	const std::wstring pattern = std::wstring(temp) + L"bound-lowbox-Bound.Lowbox.*.authority";
	Handle search;
	search.value = FindFirstFileW(pattern.c_str(), &found);
	if (search.value == INVALID_HANDLE_VALUE) {
		search.value = nullptr;
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

bool grantWritableRoot(const std::wstring& root, PSID sid, AclScope& scope) {
	return saveAndApplyAcl(root, sid,
		FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE, GRANT_ACCESS,
		SUB_CONTAINERS_AND_OBJECTS_INHERIT, scope);
}

bool protectGitControlSurfaces(const std::wstring& root, PSID sid, AclScope& scope) {
	const std::wstring git = fullPath(root + L"\\.git");
	if (git.empty() || GetFileAttributesW(git.c_str()) == INVALID_FILE_ATTRIBUTES) return true;
	const DWORD deniedWrites = FILE_GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER;
	for (const wchar_t* relative : {L"config", L"hooks"}) {
		const std::wstring path = git + L"\\" + relative;
		const DWORD attributes = GetFileAttributesW(path.c_str());
		if (attributes == INVALID_FILE_ATTRIBUTES) continue;
		const DWORD inheritance = (attributes & FILE_ATTRIBUTE_DIRECTORY)
			? SUB_CONTAINERS_AND_OBJECTS_INHERIT
			: NO_INHERITANCE;
		if (!saveAndApplyAcl(path, sid, deniedWrites, DENY_ACCESS, inheritance, scope)) return false;
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



int runCleanupWatcher(const std::wstring& journalPath, DWORD ownerPid,
	ULONGLONG expectedOwnerCreationTime, HANDLE jobHandle, HANDLE childHandle, HANDLE controlRead,
	HANDLE readyEvent, HANDLE authorityEvent, HANDLE authorityArmedEvent) {
	wchar_t neverArms[2]{};
	if (GetEnvironmentVariableW(L"BOUND_LOWBOX_TEST_WATCHER_NEVER_ARMS", neverArms, 2) > 0) {
		Sleep(LOWBOX_WATCHER_TIMEOUT_MS * 2);
		return 125;
	}
	Handle owner;
	owner.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, ownerPid);
	if (!owner.value) return 125;
	ULONGLONG ownerCreationTime = 0;
	if (!processCreationTime(owner.value, ownerCreationTime) ||
		ownerCreationTime != expectedOwnerCreationTime) return 125;
	// Ready means only that the watcher has validated its inherited authority handles. The owner still
	// owns Transferring authority until it grants authority and this watcher durably publishes Active.
	if (!SetEvent(readyEvent)) return 125;
	if (WaitForSingleObject(authorityEvent, INFINITE) != WAIT_OBJECT_0) return 125;
	DWORD watcherPid = GetCurrentProcessId();
	ULONGLONG watcherCreationTime = 0;
	if (!processCreationTime(GetCurrentProcess(), watcherCreationTime) ||
		!activateAuthorityJournalWatcher(journalPath, watcherPid, watcherCreationTime)) return 125;
	// From this acknowledgement onward, only this watcher may terminate the job, transition the
	// journal, or clean authority. The pipe carries one explicit framed CANCEL request; pipe EOF is not
	// cancellation. Owner death is observed separately through the exact owner process handle.
	if (!SetEvent(authorityArmedEvent)) return 125;
	HANDLE lifecycleSignals[] = {childHandle, owner.value, controlRead};
	bool terminateJob = false;
	for (;;) {
		const DWORD lifecycleWait = WaitForMultipleObjects(3, lifecycleSignals, FALSE, INFINITE);
		if (lifecycleWait == WAIT_OBJECT_0) break;
		if (lifecycleWait == WAIT_OBJECT_0 + 1) {
			terminateJob = true;
			break;
		}
		if (lifecycleWait != WAIT_OBJECT_0 + 2) return 125;

		char controlBuffer[16]{};
		DWORD controlBytes = 0;
		if (ReadFile(controlRead, controlBuffer, sizeof(controlBuffer), &controlBytes, nullptr)) {
			const std::string controlFrame(controlBuffer, controlBytes);
			const char cancelFrame[] = "CANCEL\n";
			if (controlFrame != cancelFrame) return 125;
			terminateJob = true;
			break;
		}
		const DWORD controlError = GetLastError();
		if (controlError != ERROR_BROKEN_PIPE) return 125;
		// EOF is not a cancel request. Stop watching the closed pipe and wait for natural child exit or
		// independently observed owner death.
		if (WaitForSingleObject(owner.value, 0) == WAIT_OBJECT_0) {
			terminateJob = true;
			break;
		}
		HANDLE remainingSignals[] = {childHandle, owner.value};
		const DWORD remainingWait = WaitForMultipleObjects(2, remainingSignals, FALSE, INFINITE);
		if (remainingWait == WAIT_OBJECT_0) break;
		if (remainingWait != WAIT_OBJECT_0 + 1) return 125;
		terminateJob = true;
		break;
	}
	if (terminateJob && !TerminateJobObject(jobHandle, 125) &&
		WaitForSingleObject(childHandle, 0) != WAIT_OBJECT_0) return 125;
	if (WaitForSingleObject(childHandle, INFINITE) != WAIT_OBJECT_0) return 125;
	if (!waitForJobTreeDeath(jobHandle, childHandle, INFINITE)) return 125;
	DWORD childPid = GetProcessId(childHandle);
	ULONGLONG childCreationTime = 0;
	const bool jobTreeDeathProof = childPid != 0 && processCreationTime(childHandle, childCreationTime);
	AuthorityRecoveryLock recoveryLock(journalPath);
	if (!recoveryLock || !jobTreeDeathProof) return 125;
	// Exact job-tree death is proved. Publish Recoverable before attempting authority cleanup so any
	// subsequent watcher failure leaves durable, startup-retryable work instead of an abandoned Active
	// journal. This transition and all cleanup remain watcher-only.
	if (!markAuthorityJournalRecoverableLocked(journalPath, childPid, childCreationTime,
		jobTreeDeathProof)) return 125;
	if (!recoverAuthorityJournalLocked(journalPath)) return 125;
	return 0;
}

WatcherStartResult startCleanupWatcher(const std::wstring& executable, const std::wstring& journalPath,
	HANDLE jobHandle, HANDLE childProcess, HANDLE& watcherProcess) {
	AuthorityRecoveryLock transferLock(journalPath);
	if (!transferLock) return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	Handle controlRead;
	Handle controlWrite;
	SECURITY_ATTRIBUTES pipeSecurity{sizeof(pipeSecurity), nullptr, TRUE};
	SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
	if (!CreatePipe(&controlRead.value, &controlWrite.value, &pipeSecurity, 0) ||
		!SetHandleInformation(controlWrite.value, HANDLE_FLAG_INHERIT, 0)) {
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
		L" --control-read-handle " +
		std::to_wstring(reinterpret_cast<uintptr_t>(controlRead.value)) +
		L" --ready-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(readyEvent.value)) +
		L" --authority-handle " + std::to_wstring(reinterpret_cast<uintptr_t>(authorityEvent.value)) +
		L" --authority-armed-handle " +
		std::to_wstring(reinterpret_cast<uintptr_t>(authorityArmedEvent.value));

	HANDLE inherited[] = {inheritedJob.value, inheritedChild.value, controlRead.value, readyEvent.value,
		authorityEvent.value, authorityArmedEvent.value};
	SIZE_T bytes = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
	AttributeList attributes;
	attributes.value = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
	if (!attributes.value || !InitializeProcThreadAttributeList(attributes.value, 1, 0, &bytes) ||
		!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
			sizeof(inherited), nullptr, nullptr)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	STARTUPINFOEXW startup{};
	startup.StartupInfo.cb = sizeof(startup);
	startup.lpAttributeList = attributes.value;
	PROCESS_INFORMATION process{};
	if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
		CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &process)) {
		return {WatcherStartOutcome::FailedPreTransfer, GetLastError()};
	}
	CloseHandle(process.hThread);
	watcherProcess = process.hProcess;
	ULONGLONG watcherCreationTime = 0;

	auto cancelPreTransferWatcherAndObserve = [&](DWORD failure) -> WatcherStartResult {
		// ARMED has not been acknowledged. This is launch rollback, not the post-arm CANCEL protocol.
		// Do not return authority to the caller until this exact watcher is proved stopped and the
		// durable journal is normalized back to fail-closed Transferring ownership. An Active journal
		// proves the watcher crossed the durable handoff boundary even if its ARMED event was lost.
		for (;;) {
			TerminateProcess(watcherProcess, 125);
			const DWORD watcherWait = WaitForSingleObject(watcherProcess, LOWBOX_WATCHER_TIMEOUT_MS);
			if (watcherWait == WAIT_OBJECT_0 &&
				resetAuthorityJournalAfterFailedHandoff(journalPath, process.dwProcessId,
					watcherCreationTime)) break;
			failure = watcherWait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
			writeControl("{\"ok\":false,\"code\":\"LOWBOX_WATCHER_STOP_RECOVERY_RETRY\","
				"\"operation\":\"TerminateProcess/WaitForSingleObject/resetAuthorityJournalAfterFailedHandoff\"}");
			Sleep(LOWBOX_RECOVERY_RETRY_MS);
		}
		CloseHandle(watcherProcess);
		watcherProcess = nullptr;
		return {WatcherStartOutcome::FailedPreTransfer, failure};
	};

	auto requestArmedWatcherCancelAndObserve = [&](DWORD failure) -> WatcherStartResult {
		const char cancelFrame[] = "CANCEL\n";
		DWORD written = 0;
		const bool cancelSent = WriteFile(controlWrite.value, cancelFrame, sizeof(cancelFrame) - 1,
			&written, nullptr) && written == sizeof(cancelFrame) - 1;
		const DWORD watcherWait = WaitForSingleObject(watcherProcess, LOWBOX_WATCHER_TIMEOUT_MS);
		const bool watcherStopped = watcherWait == WAIT_OBJECT_0;
		DWORD watcherExitCode = 125;
		const bool watcherClean = watcherStopped && GetExitCodeProcess(watcherProcess, &watcherExitCode) &&
			watcherExitCode == 0;
		const char* cancelCode = !cancelSent ? "LOWBOX_WATCHER_CANCEL_WRITE_FAILED"
			: watcherWait == WAIT_TIMEOUT ? "LOWBOX_WATCHER_CANCEL_TIMEOUT"
			: watcherClean ? "LOWBOX_WATCHER_CANCEL_SENT"
			: "LOWBOX_WATCHER_CANCEL_ABNORMAL";
		const DWORD cancelError = watcherWait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
		writeControl("{\"ok\":false,\"code\":\"" + std::string(cancelCode) +
			"\",\"operation\":\"WriteFile/WaitForSingleObject/GetExitCodeProcess\",\"win32\":" +
			std::to_string(cancelError) + "}");
		if (watcherStopped) {
			CloseHandle(watcherProcess);
			watcherProcess = nullptr;
		}
		return {WatcherStartOutcome::IndeterminateWatcherOwned, failure};
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
	return {WatcherStartOutcome::ConfirmedArmed, ERROR_SUCCESS};
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
	if (argc == 6 && std::wstring(argv[1]) == L"inspect-cleanup" &&
		std::wstring(argv[2]) == L"--profile" && std::wstring(argv[4]) == L"--path") {
		const std::wstring profileName = argv[3];
		PSID profileSid = nullptr;
		const HRESULT derived = DeriveAppContainerSidFromAppContainerName(profileName.c_str(), &profileSid);
		const bool profileExists = SUCCEEDED(derived);
		if (profileSid) FreeSid(profileSid);

		bool lowboxAce = false;
		PSECURITY_DESCRIPTOR descriptor = nullptr;
		PACL dacl = nullptr;
		const DWORD aclStatus = GetNamedSecurityInfoW(argv[5], SE_FILE_OBJECT,
			DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &descriptor);
		if (aclStatus != ERROR_SUCCESS) return 125;
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
		const bool journalExists = GetFileAttributesW(authorityJournalPath(profileName).c_str()) !=
			INVALID_FILE_ATTRIBUTES;
		std::cout << "{\"Journal\":" << (journalExists ? "true" : "false")
			<< ",\"Profile\":" << (profileExists ? "true" : "false")
			<< ",\"LowboxAces\":" << (lowboxAce ? 1 : 0) << "}" << std::endl;
		return 0;
	}
	if (argc >= 20 && std::wstring(argv[1]) == L"cleanup-watch" &&
		std::wstring(argv[2]) == L"--journal" && std::wstring(argv[4]) == L"--owner-pid" &&
		std::wstring(argv[6]) == L"--owner-created" &&
		std::wstring(argv[8]) == L"--job-handle" &&
		std::wstring(argv[10]) == L"--child-handle" &&
		std::wstring(argv[12]) == L"--control-read-handle" &&
		std::wstring(argv[14]) == L"--ready-handle" &&
		std::wstring(argv[16]) == L"--authority-handle" &&
		std::wstring(argv[18]) == L"--authority-armed-handle") {
		HANDLE job = INVALID_HANDLE_VALUE, child = INVALID_HANDLE_VALUE;
		HANDLE controlRead = INVALID_HANDLE_VALUE, ready = INVALID_HANDLE_VALUE;
		HANDLE authority = INVALID_HANDLE_VALUE, authorityArmed = INVALID_HANDLE_VALUE;
		if (!parseInheritedHandle(argv[9], job) || !parseInheritedHandle(argv[11], child) ||
			!parseInheritedHandle(argv[13], controlRead) || !parseInheritedHandle(argv[15], ready) ||
			!parseInheritedHandle(argv[17], authority) ||
			!parseInheritedHandle(argv[19], authorityArmed)) return 125;
		return runCleanupWatcher(argv[3], wcstoul(argv[5], nullptr, 10),
			_wcstoui64(argv[7], nullptr, 10), job, child, controlRead, ready, authority,
			authorityArmed);
	}

	std::wstring cwd, shell, shellFlag, command, network;
	std::vector<std::wstring> writable;
	if (!parseArguments(argc, argv, controlHandle, cwd, shell, shellFlag, command, network, writable)) {
		return 125;
	}
	if (!recoverStaleAuthority()) {
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
		startCleanupWatcher(executable, journalPath, job.value, childProcess.value, cleanupWatcher);
	if (watcherStart.outcome == WatcherStartOutcome::FailedPreTransfer) {
		return failAfterDurableAuthorityJournal("LOWBOX_WATCHER", L"startCleanupWatcher",
			watcherStart.win32, job.value, childProcess.value, 125, profile, aclScope);
	}
	if (watcherStart.outcome == WatcherStartOutcome::IndeterminateWatcherOwned) {
		return failWithoutAuthorityMutation("LOWBOX_WATCHER_INDETERMINATE", L"startCleanupWatcher",
			watcherStart.win32);
	}
	if (watcherStart.outcome != WatcherStartOutcome::ConfirmedArmed) {
		return failWithoutAuthorityMutation("LOWBOX_WATCHER_INVALID_OUTCOME", L"startCleanupWatcher",
			ERROR_INVALID_STATE);
	}
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
	writeControl("{\"ok\":true,\"pid\":" + std::to_string(process.dwProcessId) +
		",\"profile\":\"" + jsonEscape(utf8(profile.name)) + "\"}");

	const DWORD childWait = WaitForSingleObject(childProcess.value, INFINITE);
	if (childWait != WAIT_OBJECT_0) {
		requestArmedWatcherCancelAndObserve();
	}
	DWORD exitCode = 1;
	if (!GetExitCodeProcess(childProcess.value, &exitCode)) {
		requestArmedWatcherCancelAndObserve();
	}

	const WatcherTerminalStatus watcherStatus = awaitArmedWatcherTerminalStatus();
	if (watcherStatus != WatcherTerminalStatus::CleanupComplete) reportArmedWatcherAbnormalExit();
	WaitForSingleObject(stdoutThread.value, INFINITE);
	WaitForSingleObject(stderrThread.value, INFINITE);
	return static_cast<int>(exitCode);
}
