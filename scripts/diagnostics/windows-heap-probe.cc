// Diagnostic only: prearm one healthy dump helper for this fixture process.
#include "windows-minidump-protocol.h"
#include <node_api.h>
#include <strsafe.h>
#include <initializer_list>
struct CaptureState {
  volatile LONG configured = 0, started = 0;
  HANDLE target = nullptr, mapping = nullptr, event = nullptr, helper = nullptr;
  OwnedDumpRequest* request = nullptr;
};
static CaptureState capture;
static void Shutdown(void*) {
  if (capture.helper) {
    if (WaitForSingleObject(capture.helper, 0) == WAIT_TIMEOUT) {
      InterlockedExchange(&capture.request->mode, 3); SetEvent(capture.event);
      if (WaitForSingleObject(capture.helper, 5000) != WAIT_OBJECT_0) {
        TerminateProcess(capture.helper, 20003); WaitForSingleObject(capture.helper, 5000);
      }
    }
    CloseHandle(capture.helper); capture.helper = nullptr;
  }
  if (capture.request) { UnmapViewOfFile(capture.request); capture.request = nullptr; }
  for (HANDLE* handle : {&capture.target, &capture.mapping, &capture.event}) {
    if (*handle) { CloseHandle(*handle); *handle = nullptr; }
  }
}
static napi_value Configure(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0; napi_value args[2];
  wchar_t helper[2048], directory[2048], command[4096];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_string_utf16(env, args[0], reinterpret_cast<char16_t*>(helper), 2048, &length) != napi_ok || length >= 2047 ||
      napi_get_value_string_utf16(env, args[1], reinterpret_cast<char16_t*>(directory), 2048, &length) != napi_ok || length >= 1900 ||
      InterlockedCompareExchange(&capture.configured, 1, 0) != 0) {
    napi_throw_error(env, nullptr, "capture helper configuration invalid or repeated"); return nullptr;
  }
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  BOOL prepared = DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &capture.target,
      PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, TRUE, 0);
  capture.mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, &security, PAGE_READWRITE, 0, sizeof(OwnedDumpRequest), nullptr);
  capture.event = CreateEventW(&security, FALSE, FALSE, nullptr);
  capture.request = capture.mapping ? static_cast<OwnedDumpRequest*>(MapViewOfFile(capture.mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(OwnedDumpRequest))) : nullptr;
  FILETIME exited, kernel, user;
  if (!prepared || !capture.mapping || !capture.event || !capture.request ||
      !GetProcessTimes(GetCurrentProcess(), &capture.request->created, &exited, &kernel, &user)) {
    Shutdown(nullptr); napi_throw_error(env, nullptr, "capture handle preparation failed"); return nullptr;
  }
  auto* request = capture.request; request->signature = kOwnedDumpSignature; request->pid = GetCurrentProcessId();
  if (FAILED(StringCchPrintfW(request->outputPath, 2048, L"%ls\\owned-%lu.dmp", directory, request->pid))) {
    Shutdown(nullptr); napi_throw_error(env, nullptr, "capture output path too long"); return nullptr;
  }
  auto created = static_cast<ULONGLONG>(request->created.dwHighDateTime) << 32 | request->created.dwLowDateTime;
  if (FAILED(StringCchPrintfW(command, 4096, L"\"%ls\" %llx %llx %llx %lx %llx %llx", helper,
      reinterpret_cast<ULONG_PTR>(capture.target), reinterpret_cast<ULONG_PTR>(capture.mapping),
      reinterpret_cast<ULONG_PTR>(capture.event), request->pid, created, reinterpret_cast<ULONG_PTR>(request)))) {
    Shutdown(nullptr); napi_throw_error(env, nullptr, "capture helper command too long"); return nullptr;
  }
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  alignas(void*) unsigned char attributes[4096];
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes);
  HANDLE handles[]{capture.target, capture.mapping, capture.event};
  if (bytes > sizeof(attributes) || !InitializeProcThreadAttributeList(list, 1, 0, &bytes)) {
    Shutdown(nullptr); napi_throw_error(env, nullptr, "capture attribute list failed"); return nullptr;
  }
  BOOL updated = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr);
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  PROCESS_INFORMATION process{};
  BOOL started = updated && CreateProcessW(helper, command, nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr, nullptr, &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(list);
  if (!started) { Shutdown(nullptr); napi_throw_error(env, nullptr, "capture helper process creation failed"); return nullptr; }
  capture.helper = process.hProcess; CloseHandle(process.hThread);
  if (napi_add_env_cleanup_hook(env, Shutdown, nullptr) != napi_ok) {
    Shutdown(nullptr); napi_throw_error(env, nullptr, "capture cleanup registration failed"); return nullptr;
  }
  napi_value result; napi_get_boolean(env, true, &result); return result;
}
static DWORD Capture(DWORD phase, bool invalid) {
  if (!capture.helper || !capture.request) return 20001;
  if (InterlockedCompareExchange(&capture.started, 1, 0) == 0) {
    auto* request = capture.request; request->tid = GetCurrentThreadId(); request->phase = phase;
    request->heap = reinterpret_cast<ULONG_PTR>(GetProcessHeap()); RtlCaptureContext(&request->context);
    request->exception.ExceptionCode = invalid ? kHeapInvalidException : kSnapshotSmokeException;
    request->exception.ExceptionAddress = reinterpret_cast<void*>(request->context.Rip);
    request->exception.NumberParameters = 3; request->exception.ExceptionInformation[0] = phase;
    request->exception.ExceptionInformation[1] = request->heap; request->exception.ExceptionInformation[2] = request->tid;
    request->pointers = {&request->exception, &request->context};
    InterlockedExchange(&request->mode, invalid ? 2 : 1); SetEvent(capture.event);
  }
  if (WaitForSingleObject(capture.helper, kDumpWaitMs) != WAIT_OBJECT_0) {
    TerminateProcess(capture.helper, 20002); WaitForSingleObject(capture.helper, 5000); return 20002;
  }
  DWORD exit = 20004; GetExitCodeProcess(capture.helper, &exit); return exit;
}
static napi_value Snapshot(napi_env env, napi_callback_info) {
  DWORD status = Capture(0, false); napi_value result; napi_create_uint32(env, status, &result); return result;
}
static napi_value Check(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; uint32_t phase = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      (argc && napi_get_value_uint32(env, args[0], &phase) != napi_ok)) {
    napi_throw_type_error(env, nullptr, "heap probe phase must be uint32"); return nullptr;
  }
  HANDLE heap = GetProcessHeap();
  if (!heap) { napi_throw_error(env, nullptr, "GetProcessHeap failed"); return nullptr; }
  // Flags=0 preserves serialization. HeapValidate does not set LastError.
  if (!HeapValidate(heap, 0, nullptr)) {
    DWORD status = Capture(phase, true);
    ULONG_PTR details[]{phase, reinterpret_cast<ULONG_PTR>(heap), GetCurrentThreadId(), status};
    RaiseException(kHeapInvalidException, EXCEPTION_NONCONTINUABLE, 4, details); return nullptr;
  }
  napi_value result; napi_get_boolean(env, true, &result); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[]{
    {"check", nullptr, Check, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"configure", nullptr, Configure, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr}};
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
