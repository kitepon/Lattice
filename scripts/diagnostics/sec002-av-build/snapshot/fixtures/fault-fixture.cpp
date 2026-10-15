// Isolated Windows fixture SOURCE ONLY. Do not run without separate authorization.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cwchar>
#include <string>
#include <vector>
#include "../src/policy.hpp"
__declspec(noinline) void readFault(){volatile unsigned* p=nullptr;volatile unsigned n=*p;(void)n;}
__declspec(noinline) void writeFault(){volatile unsigned* p=nullptr;*p=7;}
DWORD WINAPI threadFault(void*){readFault();return 0;}
__declspec(noinline) void handledFault(){__try{readFault();}__except(GetExceptionCode()==EXCEPTION_ACCESS_VIOLATION?EXCEPTION_EXECUTE_HANDLER:EXCEPTION_CONTINUE_SEARCH){}}
int wmain(int argc,wchar_t** argv){
  if(argc!=2)return 90;const std::wstring mode=argv[1];
  if(mode==L"normal"){const char out[]="fixture stdout\r\n",err[]="fixture stderr\r\n";DWORD n=0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),out,sizeof(out)-1,&n,nullptr);WriteFile(GetStdHandle(STD_ERROR_HANDLE),err,sizeof(err)-1,&n,nullptr);return 0;}
  if(mode==L"exit1")return 1;
  if(mode==L"exit-av"){ExitProcess(0xc0000005u);}
  if(mode==L"read"){readFault();return 91;}
  if(mode==L"write"){writeFault();return 91;}
  if(mode==L"execute"){auto memory=VirtualAlloc(nullptr,4096,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!memory)return 92;
    static_cast<unsigned char*>(memory)[0]=0xc3;reinterpret_cast<void(*)()>(memory)();VirtualFree(memory,0,MEM_RELEASE);return 91;}
  if(mode==L"handled"){handledFault();return 0;}
  if(mode==L"thread"){HANDLE t=CreateThread(nullptr,0,threadFault,nullptr,0,nullptr);if(!t)return 92;WaitForSingleObject(t,INFINITE);CloseHandle(t);return 91;}
  if(mode==L"breakpoint"){DebugBreak();return 91;}
  if(mode==L"child" || mode==L"child-delay"){
    std::vector<wchar_t> name(32768);DWORD n=GetModuleFileNameW(nullptr,name.data(),static_cast<DWORD>(name.size()));if(!n||n>=name.size())return 92;
    std::wstring command=sec002::quote(std::wstring(name.data(),n))+L" "+(mode==L"child"?L"read":L"delay");
    STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION p{};
    if(!CreateProcessW(name.data(),command.data(),nullptr,nullptr,TRUE,0,nullptr,nullptr,&startup,&p))return 92;
    CloseHandle(p.hThread);if(mode==L"child-delay"){CloseHandle(p.hProcess);return 0;}
    WaitForSingleObject(p.hProcess,INFINITE);DWORD exit=0;GetExitCodeProcess(p.hProcess,&exit);CloseHandle(p.hProcess);ExitProcess(exit);
  }
  if(mode==L"delay"){Sleep(250);return 0;}
  return 90;
}
