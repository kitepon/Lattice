"""Read source contracts only. No Win32 execution or compiler success claim."""
import json, pathlib, shutil
root=pathlib.Path(__file__).resolve().parents[1]
c=(root/'src/capture.cpp').read_text()
p=(root/'src/policy.hpp').read_text()
b=(root/'build/build-msvc.ps1').read_text()
checks={
 'two_fixed_calls': 'cli-idempotent' in p and 'order==2' in p and 'cli-recovery' in p and 'order==3' in p,
 'debug_chain_not_only_this': 'DEBUG_PROCESS|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT' in c and 'DEBUG_ONLY_THIS_PROCESS' not in c,
 'no_other_process_attach': all(x not in c for x in ['DebugActiveProcess(', 'OpenProcess(', 'OpenThread(', 'CreateToolhelp32Snapshot(', 'EnumProcesses(']),
 'no_dump_or_symbol_apis': all(x not in c for x in ['MiniDumpWriteDump(', 'SymInitialize(', 'SymLoadModule', 'StackWalk64(', 'LoadLibrary(']),
 'metadata_only_schema': 'sec002-av-capture-v1-metadata-only' in c and '\\"stackAvailable\\":false' in c and 'not_implemented' in c,
 'heap_request_fixed': 'SetEnvironmentVariableW(L"_NO_DEBUG_HEAP",L"1")' in c and 'debugHeapDisableRequested' in c and 'debugHeapDisabled' not in c,
 'no_debug_string_read': 'case OUTPUT_DEBUG_STRING_EVENT:break;' in c,
 'private_dup_context': 'duplicate(e.hThread)' in c and 'GetThreadContext(thread->second.h,&context)' in c and 'alignas(16) CONTEXT' in c,
 'restricted_stdio': 'PROC_THREAD_ATTRIBUTE_HANDLE_LIST' in c and 'sizeof(HANDLE)*3' in c,
 'suspended_assign_first': c.index('AssignProcessToJobObject')<c.index('ResumeThread('),
 'kill_on_close_only': 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE' in c and 'BREAKAWAY_OK' not in c,
 'no_infinite_api_wait': 'WaitForDebugEvent(&event,INFINITE)' not in c,
 'failed_launch_skips_main_loop': 'for(;resumed;)' in c,
 'independent_exit_status': 'return c.outerExited?c.exitCode:125;' in c,
 'dword_exit_forwarded': 'ExitProcess(status)' in c,
 'bounded_output': 'row.size()>sec002::kOutputLimit' in c and 'kOutputLimit=65536' in p,
 'bounded_owned_handles': 'exitedHandles.size()<sec002::kProcesses' in c,
 'new_capture_file': 'CREATE_NEW' in c,
 'rsds_without_path': 'std::array<unsigned char,24> cv' in c,
 'cleanup_reported': 'drainTimedOut' in c and 'remainingActiveProcesses' in c,
 'no_fixture_run_recipe': 'Start-Process' not in b and '& ./capture' not in b,
 'manifest_required': 'dependency_content_mismatch' in b and 'DependencyManifestSha256' in b,
 'strict_warnings': "'/WX'" in b,
}
result={'kind':'static-source-contract-only','windowsValidated':False,'binaryPresent':False,
 'checks':checks,'passed':sum(checks.values()),'failed':sum(not v for v in checks.values()),
 'localToolchain':{name:shutil.which(name) for name in ['g++','clang++','clang-cl','x86_64-w64-mingw32-g++','objdump']},
 'knownWindowsHeaders':{path:pathlib.Path(path).is_file() for path in ['/usr/x86_64-w64-mingw32/include/windows.h','/usr/share/mingw-w64/include/windows.h','/usr/include/windows.h']}}
print(json.dumps(result,indent=2))
raise SystemExit(0 if all(checks.values()) else 1)
