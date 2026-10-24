#pragma once
#include <windows.h>

constexpr DWORD kOwnedDumpSignature = 0x4c484450;
constexpr DWORD kHeapInvalidException = 0xE0424C54;
constexpr DWORD kSnapshotSmokeException = 0xE0424C53;
constexpr DWORD kDumpWaitMs = 15000;
constexpr ULONG64 kDumpByteLimit = 2ull * 1024 * 1024 * 1024;
// Only inherited anonymous handles connect the target and its own helper.
struct OwnedDumpRequest {
  DWORD signature;
  volatile LONG mode;  // 0 idle, 1 healthy snapshot, 2 invalid heap, 3 shutdown
  DWORD pid;
  DWORD tid;
  DWORD phase;
  ULONG_PTR heap;
  FILETIME created;
  CONTEXT context;
  EXCEPTION_RECORD exception;
  EXCEPTION_POINTERS pointers;  // addresses in the target process
  wchar_t outputPath[2048];
};
