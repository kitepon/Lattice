// Diagnostic helper. It cannot open a process by PID: only the target's
// inherited real handle is accepted. DbgHelp runs in this healthy process.
#include "windows-minidump-protocol.h"
#include <dbghelp.h>
#include <cstddef>
#include <cstdio>
#include <cwchar>
#include <string>

struct WriterState {
  HANDLE file;
  ULONGLONG started;
  DWORD error = 0;
  unsigned threads = 0;
  unsigned modules = 0;
};

static BOOL CALLBACK DumpCallback(PVOID parameter, const PMINIDUMP_CALLBACK_INPUT input,
                                  PMINIDUMP_CALLBACK_OUTPUT output) {
  auto* state = static_cast<WriterState*>(parameter);
  switch (input->CallbackType) {
    case ThreadCallback: ++state->threads; return TRUE;
    case ModuleCallback: ++state->modules; return TRUE;
    case MemoryCallback: return FALSE;
    case IncludeVmRegionCallback: output->Continue = TRUE; return TRUE;
    case CancelCallback:
      output->CheckCancel = TRUE;
      output->Cancel = GetTickCount64() - state->started > kDumpWaitMs;
      return TRUE;
    case IoStartCallback: output->Status = S_FALSE; return TRUE;
    case IoFinishCallback: output->Status = S_OK; return TRUE;
    case IoWriteAllCallback: {
      if (input->Io.Offset > kDumpByteLimit || input->Io.BufferBytes > kDumpByteLimit - input->Io.Offset) {
        state->error = ERROR_FILE_TOO_LARGE;
        output->Status = HRESULT_FROM_WIN32(state->error);
        return FALSE;
      }
      if (GetTickCount64() - state->started > kDumpWaitMs) {
        state->error = ERROR_TIMEOUT;
        output->Status = HRESULT_FROM_WIN32(state->error);
        return FALSE;
      }
      LARGE_INTEGER offset; offset.QuadPart = input->Io.Offset;
      DWORD written = 0;
      if (!SetFilePointerEx(state->file, offset, nullptr, FILE_BEGIN) ||
          !WriteFile(state->file, input->Io.Buffer, input->Io.BufferBytes, &written, nullptr) ||
          written != input->Io.BufferBytes) {
        state->error = GetLastError();
        if (!state->error) state->error = ERROR_WRITE_FAULT;
        output->Status = HRESULT_FROM_WIN32(state->error);
        return FALSE;
      }
      output->Status = S_OK;
      return TRUE;
    }
    // Never hide a failed memory read behind a successful receipt.
    case ReadMemoryFailureCallback: return FALSE;
    default: return TRUE;
  }
}

static unsigned long long Number(const wchar_t* text) {
  wchar_t* end = nullptr;
  auto n = wcstoull(text, &end, 16);
  return end && *end == 0 ? n : 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 7) return 10;
  HANDLE target = reinterpret_cast<HANDLE>(Number(argv[1]));
  HANDLE mapping = reinterpret_cast<HANDLE>(Number(argv[2]));
  HANDLE event = reinterpret_cast<HANDLE>(Number(argv[3]));
  DWORD expectedPid = static_cast<DWORD>(Number(argv[4]));
  auto expectedCreated = Number(argv[5]);
  auto remoteBase = static_cast<ULONG_PTR>(Number(argv[6]));
  FILETIME created, exited, kernel, user;
  if (!target || GetProcessId(target) != expectedPid ||
      !GetProcessTimes(target, &created, &exited, &kernel, &user) ||
      (static_cast<ULONGLONG>(created.dwHighDateTime) << 32 | created.dwLowDateTime) != expectedCreated) return 11;
  auto* request = static_cast<OwnedDumpRequest*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(OwnedDumpRequest)));
  if (!request || request->signature != kOwnedDumpSignature || request->pid != expectedPid ||
      CompareFileTime(&created, &request->created) != 0) return 12;
  HANDLE waits[] = { target, event };
  if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0 + 1) return 0;
  if (request->mode == 3) return 0;
  if ((request->mode != 1 && request->mode != 2) ||
      request->pointers.ExceptionRecord != reinterpret_cast<PEXCEPTION_RECORD>(remoteBase + offsetof(OwnedDumpRequest, exception)) ||
      request->pointers.ContextRecord != reinterpret_cast<PCONTEXT>(remoteBase + offsetof(OwnedDumpRequest, context))) return 13;
  DWORD signature = 0; SIZE_T read = 0;
  if (!ReadProcessMemory(target, reinterpret_cast<void*>(remoteBase), &signature, sizeof(signature), &read) ||
      read != sizeof(signature) || signature != kOwnedDumpSignature) return 14;
  HMODULE dbghelp = LoadLibraryExW(L"dbghelp.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  using WriteDump = decltype(&MiniDumpWriteDump);
  auto writeDump = dbghelp ? reinterpret_cast<WriteDump>(GetProcAddress(dbghelp, "MiniDumpWriteDump")) : nullptr;
  if (!writeDump) return 15;
  wchar_t modulePath[MAX_PATH] = {};
  GetModuleFileNameW(dbghelp, modulePath, MAX_PATH);
  HANDLE file = CreateFileW(request->outputPath, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 16;
  WriterState state{file, GetTickCount64()};
  MINIDUMP_CALLBACK_INFORMATION callback{DumpCallback, &state};
  MINIDUMP_EXCEPTION_INFORMATION exception{request->tid,
      reinterpret_cast<PEXCEPTION_POINTERS>(remoteBase + offsetof(OwnedDumpRequest, pointers)), TRUE};
  auto type = static_cast<MINIDUMP_TYPE>(MiniDumpWithFullMemory | MiniDumpWithFullMemoryInfo |
      MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules);
  BOOL ok = writeDump(target, expectedPid, file, type, &exception, nullptr, &callback);
  DWORD error = ok ? 0 : GetLastError();
  LARGE_INTEGER size{}; GetFileSizeEx(file, &size);
  CloseHandle(file);
  std::wstring receipt = std::wstring(request->outputPath) + L".json";
  FILE* report = nullptr;
  if (_wfopen_s(&report, receipt.c_str(), L"wx") == 0 && report) {
    // System32's path has no user-supplied JSON text; write slashes portably.
    for (auto* p = modulePath; *p; ++p) if (*p == L'\\') *p = L'/';
    fwprintf(report, L"{\"pid\":%lu,\"tid\":%lu,\"phase\":%lu,\"mode\":%ld,\"ok\":%ls,\"hresult\":%lu,\"ioError\":%lu,\"bytes\":%lld,\"threadCallbacks\":%u,\"moduleCallbacks\":%u,\"dbghelp\":\"%ls\"}\n",
        expectedPid, request->tid, request->phase, request->mode, ok ? L"true" : L"false", error,
        state.error, size.QuadPart, state.threads, state.modules, modulePath);
    fclose(report);
  }
  UnmapViewOfFile(request);
  CloseHandle(mapping); CloseHandle(event); CloseHandle(target);
  FreeLibrary(dbghelp);
  return ok && state.threads && state.modules && size.QuadPart > 0 ? 0 : 17;
}
