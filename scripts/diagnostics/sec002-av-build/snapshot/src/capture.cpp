// PREPARATION ONLY: uncompiled Win32 candidate. No product hook/caller integration.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdint>
#include <cwchar>
#include <cwctype>
#include <cstring>
#include <filesystem>
#include <map>
#include <sstream>
#include <string>
#include <vector>
#include <array>
#include <stdexcept>
#include "policy.hpp"
static_assert(sizeof(void*)==8,"x64 only");
namespace {
struct Handle {
  HANDLE h=nullptr;
  Handle()=default; explicit Handle(HANDLE v):h(v){}
  Handle(const Handle&)=delete; Handle& operator=(const Handle&)=delete;
  Handle(Handle&& o) noexcept:h(o.h){o.h=nullptr;}
  Handle& operator=(Handle&& o) noexcept {if(this!=&o){reset();h=o.h;o.h=nullptr;}return *this;}
  ~Handle(){reset();}
  void reset(HANDLE v=nullptr){if(h && h!=INVALID_HANDLE_VALUE) CloseHandle(h);h=v;}
  explicit operator bool()const{return h && h!=INVALID_HANDLE_VALUE;}
};
Handle duplicate(HANDLE h,bool inherit=false){
  HANDLE copy=nullptr;
  if(!h || h==INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(),h,GetCurrentProcess(),&copy,0,inherit,DUPLICATE_SAME_ACCESS))return {};
  return Handle(copy);
}
std::string hex(std::uint64_t n){std::ostringstream o;o<<"0x"<<std::hex<<n;return o.str();}
std::wstring filePath(HANDLE h){
  std::array<wchar_t,32768> b{};
  DWORD n=GetFinalPathNameByHandleW(h,b.data(),static_cast<DWORD>(b.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(!n || n>=b.size())return {};return {b.data(),n};
}
std::wstring lower(std::wstring s){for(auto& c:s)c=static_cast<wchar_t>(towlower(c));return s;}
std::wstring basename(const std::wstring& p){auto pos=p.find_last_of(L"\\/");return lower(p.substr(pos==p.npos?0:pos+1));}
std::uint64_t nameHash(const std::wstring& s){std::uint64_t h=14695981039346656037ull;for(wchar_t c:s){h^=static_cast<unsigned>(c);h*=1099511628211ull;}return h;}
std::wstring systemNtdll(){std::array<wchar_t,32768> b{};UINT n=GetSystemDirectoryW(b.data(),static_cast<UINT>(b.size()));if(!n||n>=b.size())return {};return lower(std::wstring(L"\\\\?\\")+std::wstring(b.data(),n)+L"\\ntdll.dll");}
bool readFileAt(HANDLE h,std::uint64_t offset,void* dst,DWORD count,std::uint64_t length){
  if(!sec002::span(offset,count,length))return false;
  LARGE_INTEGER p{};p.QuadPart=static_cast<LONGLONG>(offset);DWORD got=0;
  return SetFilePointerEx(h,p,nullptr,FILE_BEGIN) && ReadFile(h,dst,count,&got,nullptr) && got==count;
}
struct Module {
  std::uint64_t base=0,name=0;DWORD size=0,timestamp=0,age=0;
  std::array<unsigned char,16> guid{};bool pe=false,rsds=false,ntdll=false,node=false;
  std::vector<std::pair<DWORD,DWORD>> executable;
  const char* imageClass="other-image";
};
Module module(HANDLE file,std::uint64_t base,const std::wstring& nodePath){
  Module m;m.base=base;
  if(!file || file==INVALID_HANDLE_VALUE)return m;
  const auto p=lower(filePath(file));const auto name=basename(p);m.name=nameHash(name);
  m.ntdll=!p.empty() && p==systemNtdll();m.node=!p.empty() && p==lower(nodePath);
  m.imageClass=m.node?"node":m.ntdll?"ntdll":name.size()>5 && name.substr(name.size()-5)==L".node"?"native-addon":"other-image";
  LARGE_INTEGER length{};if(!GetFileSizeEx(file,&length)||length.QuadPart<=0)return m;
  auto read=[&](std::uint64_t off,void* dst,DWORD n){return readFileAt(file,off,dst,n,static_cast<std::uint64_t>(length.QuadPart));};
  IMAGE_DOS_HEADER dos{};if(!read(0,&dos,sizeof(dos))||dos.e_magic!=IMAGE_DOS_SIGNATURE||dos.e_lfanew<0)return m;
  IMAGE_NT_HEADERS64 nt{};if(!read(static_cast<unsigned>(dos.e_lfanew),&nt,sizeof(nt))||nt.Signature!=IMAGE_NT_SIGNATURE||
    nt.FileHeader.Machine!=IMAGE_FILE_MACHINE_AMD64||nt.OptionalHeader.Magic!=IMAGE_NT_OPTIONAL_HDR64_MAGIC||
    nt.FileHeader.NumberOfSections>96||nt.FileHeader.SizeOfOptionalHeader!=sizeof(IMAGE_OPTIONAL_HEADER64))return m;
  m.size=nt.OptionalHeader.SizeOfImage;m.timestamp=nt.FileHeader.TimeDateStamp;if(!m.size)return m;
  std::vector<IMAGE_SECTION_HEADER> sections(nt.FileHeader.NumberOfSections);
  const std::uint64_t table=static_cast<unsigned>(dos.e_lfanew)+sizeof(nt);
  if(!read(table,sections.data(),static_cast<DWORD>(sections.size()*sizeof(IMAGE_SECTION_HEADER))))return m;
  for(const auto& s:sections) {
    DWORD size=s.Misc.VirtualSize;
    if((s.Characteristics&IMAGE_SCN_MEM_EXECUTE) && sec002::span(s.VirtualAddress,size,m.size))m.executable.emplace_back(s.VirtualAddress,size);
  }
  m.pe=true;
  auto raw=[&](DWORD rva,DWORD n,std::uint64_t& off){
    for(const auto& s:sections)if(rva>=s.VirtualAddress && sec002::span(rva-s.VirtualAddress,n,s.SizeOfRawData)){
      off=static_cast<std::uint64_t>(s.PointerToRawData)+(rva-s.VirtualAddress);return sec002::span(off,n,length.QuadPart);
    }return false;
  };
  if(nt.OptionalHeader.NumberOfRvaAndSizes<=IMAGE_DIRECTORY_ENTRY_DEBUG)return m;
  const auto d=nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG];std::uint64_t off=0;
  if(!d.Size || d.Size>sizeof(IMAGE_DEBUG_DIRECTORY)*128 || d.Size%sizeof(IMAGE_DEBUG_DIRECTORY)||!raw(d.VirtualAddress,d.Size,off))return m;
  for(DWORD i=0;i<d.Size/sizeof(IMAGE_DEBUG_DIRECTORY);++i){
    IMAGE_DEBUG_DIRECTORY entry{};if(!read(off+i*sizeof(entry),&entry,sizeof(entry)))break;
    if(entry.Type!=IMAGE_DEBUG_TYPE_CODEVIEW||entry.SizeOfData<24)continue;
    std::array<unsigned char,24> cv{}; // Read GUID+age only; never read embedded PDB path.
    if(!read(entry.PointerToRawData,cv.data(),static_cast<DWORD>(cv.size()))||memcmp(cv.data(),"RSDS",4)!=0)continue;
    memcpy(m.guid.data(),cv.data()+4,16);memcpy(&m.age,cv.data()+20,4);m.rsds=true;break;
  }
  return m;
}
std::string moduleJson(const Module* m,std::uint64_t ip){
  if(!m)return "{\"imageClass\":\"unknown-region\"}";
  std::ostringstream o;o<<"{\"imageClass\":\""<<m->imageClass<<"\",\"nameHash\":\""<<hex(m->name)<<"\",\"peValid\":"<<(m->pe?"true":"false")
    <<",\"timestamp\":"<<m->timestamp<<",\"imageSize\":"<<m->size<<",\"rva\":\""<<hex(ip-m->base)<<"\",\"codeViewPresent\":"<<(m->rsds?"true":"false");
  if(m->rsds){const char* chars="0123456789abcdef";std::string g;for(auto c:m->guid){g+=chars[c>>4];g+=chars[c&15];}o<<",\"codeViewGuidBytes\":\""<<g<<"\",\"codeViewAge\":"<<m->age;}
  return o.str()+"}";
}
struct Process {Handle handle;DWORD initialThread=0;sec002::Startup startup;bool targetNode=false;std::map<std::uint64_t,Module> modules;};
struct Capture {
  std::map<DWORD,Process> processes;
  std::map<std::pair<DWORD,DWORD>,Handle> threads;
  std::string caseId;unsigned callOrder=0;
  bool coverage=true,cleanupForced=false,fault=false,metadata=false,writeFailed=false,outerExited=false,drainTimedOut=false;
  DWORD remainingActiveProcesses=0;
  std::vector<Handle> exitedHandles;
  void keepExited(Handle&& handle){if(exitedHandles.size()<sec002::kProcesses)exitedHandles.push_back(std::move(handle));else coverage=false;}
  DWORD root=0,exitCode=125;std::string faultRecord;
  Module* find(Process& p,std::uint64_t ip){for(auto& entry:p.modules){auto& m=entry.second;if(ip>=m.base && ip-m.base<m.size)return &m;}return nullptr;}
  void addModule(Process& p,HANDLE h,std::uint64_t base,const std::wstring& nodePath){
    Handle file(h); // hFile is caller-owned, unlike event process/thread handles.
    if(p.modules.size()>=sec002::kModules){coverage=false;return;}
    auto m=module(file.h,base,nodePath);if(!m.pe)coverage=false;if(m.node)p.targetNode=true;p.modules[base]=std::move(m);
  }
  bool loaderAddress(Process& p,const EXCEPTION_RECORD& e){
    auto ip=reinterpret_cast<std::uint64_t>(e.ExceptionAddress);Module* m=find(p,ip);
    if(!m||!m->ntdll||!m->pe)return false;
    bool executable=false;for(auto s:m->executable)if(ip-m->base>=s.first && ip-m->base-s.first<s.second)executable=true;
    if(!executable)return false;unsigned char byte=0;SIZE_T got=0;
    return ReadProcessMemory(p.handle.h,e.ExceptionAddress,&byte,1,&got)&&got==1&&byte==0xcc;
  }
  void recordFault(Process& p,const DEBUG_EVENT& event){
    if(fault){coverage=false;return;}fault=true;
    const auto& e=event.u.Exception.ExceptionRecord;
    auto ip=reinterpret_cast<std::uint64_t>(e.ExceptionAddress);Module* m=find(p,ip);
    auto thread=threads.find({event.dwProcessId,event.dwThreadId});alignas(16) CONTEXT context{};context.ContextFlags=CONTEXT_CONTROL;
    bool contextRead=thread!=threads.end() && GetThreadContext(thread->second.h,&context);
    MEMORY_BASIC_INFORMATION region{};const char* ipRegion="unknown";
    if(VirtualQueryEx(p.handle.h,e.ExceptionAddress,&region,sizeof(region))==sizeof(region)){
      if(region.State==MEM_COMMIT)ipRegion=region.Type==MEM_PRIVATE?"anonymous-private":region.Type==MEM_IMAGE?"mapped-image":region.Type==MEM_MAPPED?"mapped-nonimage":"unknown";
      else ipRegion="uncommitted";
    }
    metadata=e.NumberParameters>=2 && m && m->pe;
    FILETIME utc{};GetSystemTimeAsFileTime(&utc);ULARGE_INTEGER ticks{};ticks.LowPart=utc.dwLowDateTime;ticks.HighPart=utc.dwHighDateTime;
    std::ostringstream o;o<<"{\"utcFileTime100ns\":\""<<ticks.QuadPart<<"\",\"pid\":"<<event.dwProcessId<<",\"threadId\":"<<event.dwThreadId<<",\"targetNode\":"<<(p.targetNode?"true":"false")
      <<",\"exceptionCode\":3221225477,\"exceptionFlags\":"<<e.ExceptionFlags<<",\"secondChance\":true,\"ip\":\""<<hex(ip)<<"\",\"access\":\""
      <<sec002::access(e.NumberParameters>=1?e.ExceptionInformation[0]:~0ull)<<"\",\"accessAddressAvailable\":"<<(e.NumberParameters>=2?"true":"false");
    if(e.NumberParameters>=2)o<<",\"accessAddress\":\""<<hex(e.ExceptionInformation[1])<<"\"";
    o<<",\"ipRegion\":\""<<ipRegion<<"\",\"module\":"<<moduleJson(m,ip)<<",\"contextRead\":"<<(contextRead?"true":"false")
      <<",\"stackComplete\":false,\"stackStop\":\"not_implemented\",\"frames\":[]}";
    faultRecord=o.str(); // No StackWalk/Sym* call until the Windows isolation gate is passed.
  }
  std::string summary(const char* state){
    std::ostringstream o;o<<"{\"schema\":\"sec002-av-capture-v1-metadata-only\",\"state\":\""<<state<<"\",\"caseId\":\""<<caseId<<"\",\"callOrder\":"<<callOrder<<",\"rootPid\":"<<root
      <<",\"outerExited\":"<<(outerExited?"true":"false")<<",\"outerExitCode\":"<<exitCode
      <<",\"debugHeapDisableRequested\":true,\"collectorCoverageComplete\":"<<(coverage?"true":"false")
      <<",\"faultObserved\":"<<(fault?"true":"false")<<",\"faultMetadataComplete\":"<<(metadata?"true":"false")
      <<",\"stackComplete\":false,\"stackAvailable\":false,\"cleanupForced\":"<<(cleanupForced?"true":"false")
      <<",\"drainTimedOut\":"<<(drainTimedOut?"true":"false")<<",\"remainingActiveProcesses\":"<<remainingActiveProcesses
      <<",\"fault\":"<<(faultRecord.empty()?"null":faultRecord)<<"}\n";
    return o.str();
  }
};
struct AttributeList {
  std::vector<unsigned char> bytes;LPPROC_THREAD_ATTRIBUTE_LIST list=nullptr;
  ~AttributeList(){if(list)DeleteProcThreadAttributeList(list);}
  bool initialize(HANDLE* stdio){SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);if(!size)return false;
    bytes.resize(size);auto p=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
    if(!InitializeProcThreadAttributeList(p,1,0,&size))return false;list=p;
    return UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,stdio,sizeof(HANDLE)*3,nullptr,nullptr)!=FALSE;
  }
};
bool save(HANDLE file,const std::string& row){if(row.size()>sec002::kOutputLimit)return false;
  LARGE_INTEGER zero{};DWORD written=0;return SetFilePointerEx(file,zero,nullptr,FILE_BEGIN)&&SetEndOfFile(file)&&
    WriteFile(file,row.data(),static_cast<DWORD>(row.size()),&written,nullptr)&&written==row.size()&&FlushFileBuffers(file);}
DWORD run(int argc,wchar_t** argv){
  // Interface: helper case order output node [original argv...]. Paths are never logged.
  if(argc<6 || !sec002::target(argv[1],std::wstring(argv[2])==L"2"?2:std::wstring(argv[2])==L"3"?3:0) ||
    !std::filesystem::path(argv[3]).is_absolute() || !std::filesystem::path(argv[4]).is_absolute())return 125;
  Handle output(CreateFileW(argv[3],GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));if(!output)return 125;
  Handle nodeFile(CreateFileW(argv[4],GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
  const std::wstring nodePath=nodeFile?filePath(nodeFile.h):L"";
  if(nodePath.empty())return 125;
  Capture c;c.caseId=std::wstring(argv[1])==L"cli-idempotent"?"cli-idempotent":"cli-recovery";c.callOrder=c.caseId=="cli-idempotent"?2:3;c.coverage=false;if(!save(output.h,c.summary("launch_pending")))return 125;c.coverage=true;
  Handle job(CreateJobObjectW(nullptr,nullptr));if(!job){c.coverage=false;save(output.h,c.summary("unavailable"));return 125;}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){c.coverage=false;save(output.h,c.summary("unavailable"));return 125;}
  std::array<Handle,3> stdio;const DWORD ids[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};HANDLE list[3]{};
  for(unsigned i=0;i<3;++i){stdio[i]=duplicate(GetStdHandle(ids[i]),true);if(!stdio[i]){c.coverage=false;save(output.h,c.summary("unavailable"));return 125;}list[i]=stdio[i].h;}
  AttributeList attributes;if(!attributes.initialize(list)){c.coverage=false;save(output.h,c.summary("unavailable"));return 125;}
  // Only the child tree inherits the fixed heap request. The helper exits without reuse.
  if(!SetEnvironmentVariableW(L"_NO_DEBUG_HEAP",L"1")){c.coverage=false;save(output.h,c.summary("unavailable"));return 125;}
  std::wstring command=sec002::quote(argv[4]);for(int i=5;i<argc;++i){command+=L' ';command+=sec002::quote(argv[i]);}
  STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput=list[0];startup.StartupInfo.hStdOutput=list[1];startup.StartupInfo.hStdError=list[2];startup.lpAttributeList=attributes.list;
  PROCESS_INFORMATION raw{};
  if(!CreateProcessW(argv[4],command.data(),nullptr,nullptr,TRUE,DEBUG_PROCESS|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,
      nullptr,nullptr,&startup.StartupInfo,&raw)){c.coverage=false;save(output.h,c.summary("unavailable"));return 125;}
  Handle rootProcess(raw.hProcess),rootThread(raw.hThread);c.root=raw.dwProcessId;
  const bool assigned=AssignProcessToJobObject(job.h,rootProcess.h)!=FALSE;
  const bool killPolicy=DebugSetProcessKillOnExit(FALSE)!=FALSE;
  const bool resumed=assigned && killPolicy && ResumeThread(rootThread.h)!=static_cast<DWORD>(-1);
  // Drop both duplicates AND originals so helper cannot hold the parent's pipe open.
  for(unsigned i=0;i<3;++i){stdio[i].reset();HANDLE original=GetStdHandle(ids[i]);if(original && original!=INVALID_HANDLE_VALUE){
    bool already=false;for(unsigned j=0;j<i;++j)if(GetStdHandle(ids[j])==original)already=true;if(!already)CloseHandle(original);}}
  if(!resumed){c.coverage=false;c.cleanupForced=true;TerminateProcess(rootProcess.h,125);}
  bool loopFailed=!resumed;
  for(;resumed;){
    DEBUG_EVENT event{};
    if(!WaitForDebugEvent(&event,500)){
      if(GetLastError()==ERROR_SEM_TIMEOUT)continue; // No additional product deadline. Parent job retains its original budget.
      loopFailed=true;c.coverage=false;c.cleanupForced=true;break;
    }
    DWORD disposition=DBG_CONTINUE;auto found=c.processes.find(event.dwProcessId);
    switch(event.dwDebugEventCode){
      case CREATE_PROCESS_DEBUG_EVENT:{
        const auto& e=event.u.CreateProcessInfo;
        if(c.processes.size()>=sec002::kProcesses){Handle file(e.hFile);c.coverage=false;c.cleanupForced=true;loopFailed=true;break;}
        Process p;p.handle=duplicate(e.hProcess);p.initialThread=event.dwThreadId;if(!p.handle)c.coverage=false;
        c.addModule(p,e.hFile,reinterpret_cast<std::uint64_t>(e.lpBaseOfImage),nodePath);
        c.processes[event.dwProcessId]=std::move(p);
        if(c.threads.size()<sec002::kThreads){auto h=duplicate(e.hThread);if(!h)c.coverage=false;c.threads[{event.dwProcessId,event.dwThreadId}]=std::move(h);}
        else c.coverage=false;
        break;
      }
      case CREATE_THREAD_DEBUG_EVENT:
        if(c.threads.size()<sec002::kThreads){auto h=duplicate(event.u.CreateThread.hThread);if(!h)c.coverage=false;c.threads[{event.dwProcessId,event.dwThreadId}]=std::move(h);}else c.coverage=false;
        break;
      case LOAD_DLL_DEBUG_EVENT:
        if(found!=c.processes.end())c.addModule(found->second,event.u.LoadDll.hFile,reinterpret_cast<std::uint64_t>(event.u.LoadDll.lpBaseOfDll),nodePath);
        else{Handle file(event.u.LoadDll.hFile);c.coverage=false;}
        break;
      case UNLOAD_DLL_DEBUG_EVENT:
        if(found!=c.processes.end())found->second.modules.erase(reinterpret_cast<std::uint64_t>(event.u.UnloadDll.lpBaseOfDll));else c.coverage=false;break;
      case EXCEPTION_DEBUG_EVENT:
        disposition=DBG_EXCEPTION_NOT_HANDLED;
        if(found!=c.processes.end()){
          const auto& e=event.u.Exception;auto d=sec002::exception(found->second.startup,e.ExceptionRecord.ExceptionCode,e.dwFirstChance!=0,
            event.dwThreadId==found->second.initialThread,
            found->second.startup.firstException && e.dwFirstChance && e.ExceptionRecord.ExceptionCode==EXCEPTION_BREAKPOINT &&
            event.dwThreadId==found->second.initialThread && c.loaderAddress(found->second,e.ExceptionRecord));
          disposition=d.disposition;if(d.startupUnknown)c.coverage=false;
          if(d.captureAv){c.recordFault(found->second,event);if(!save(output.h,c.summary("fault_pending_exit"))){c.writeFailed=true;c.coverage=false;}}
        }else c.coverage=false;
        break;
      case EXIT_THREAD_DEBUG_EVENT:c.threads.erase({event.dwProcessId,event.dwThreadId});break;
      case EXIT_PROCESS_DEBUG_EVENT:
        if(event.dwProcessId==c.root){c.outerExited=true;c.exitCode=event.u.ExitProcess.dwExitCode;}
        if(found==c.processes.end())c.coverage=false;else if(!found->second.startup.loaderSeen)c.coverage=false;
        for(auto it=c.threads.begin();it!=c.threads.end();)if(it->first.first==event.dwProcessId)it=c.threads.erase(it);else ++it;
        if(found!=c.processes.end() && found->second.handle)c.keepExited(std::move(found->second.handle));
        c.processes.erase(event.dwProcessId);break;
      case OUTPUT_DEBUG_STRING_EVENT:break; // Deliberately do not read target string.
      case RIP_EVENT:c.coverage=false;break;
      default:c.coverage=false;break;
    }
    // Raw debug hProcess/hThread are OS-owned: Continue EXIT closes them.
    if(!ContinueDebugEvent(event.dwProcessId,event.dwThreadId,disposition)){loopFailed=true;c.coverage=false;c.cleanupForced=true;break;}
    if(loopFailed)break;
    if(c.outerExited && c.processes.empty())break;
  }
  if(loopFailed || !resumed){
    c.coverage=false;c.cleanupForced=true;
    if(assigned)TerminateJobObject(job.h,125);else TerminateProcess(rootProcess.h,125);
    // A cleanup budget is not a target/test timeout. Failure remains incomplete.
    const ULONGLONG deadline=GetTickCount64()+5000;
    bool rootExitSeen=c.outerExited;
    while((!rootExitSeen || !c.processes.empty()) && GetTickCount64()<deadline){
      DEBUG_EVENT e{};
      if(!WaitForDebugEvent(&e,100)){
        if(GetLastError()==ERROR_SEM_TIMEOUT)continue;
        break;
      }
      if(e.dwDebugEventCode==CREATE_PROCESS_DEBUG_EVENT){
        Handle file(e.u.CreateProcessInfo.hFile);
        if(c.processes.size()<sec002::kProcesses){Process p;p.handle=duplicate(e.u.CreateProcessInfo.hProcess);c.processes[e.dwProcessId]=std::move(p);}
      }
      if(e.dwDebugEventCode==LOAD_DLL_DEBUG_EVENT){Handle file(e.u.LoadDll.hFile);}
      if(e.dwDebugEventCode==EXIT_PROCESS_DEBUG_EVENT){
        if(e.dwProcessId==c.root){rootExitSeen=true;c.outerExited=true;c.exitCode=e.u.ExitProcess.dwExitCode;}
        auto it=c.processes.find(e.dwProcessId);
        if(it!=c.processes.end() && it->second.handle)c.keepExited(std::move(it->second.handle));
        c.processes.erase(e.dwProcessId);
      }
      if(!ContinueDebugEvent(e.dwProcessId,e.dwThreadId,e.dwDebugEventCode==EXCEPTION_DEBUG_EVENT?DBG_EXCEPTION_NOT_HANDLED:DBG_CONTINUE))break;
    }
    c.drainTimedOut=!rootExitSeen || !c.processes.empty();
  }
  // EXIT events precede signaled process handles / job accounting. Wait after Continue.
  const ULONGLONG exitDeadline=GetTickCount64()+5000;
  for(auto& process:c.exitedHandles){
    const ULONGLONG now=GetTickCount64();
    DWORD remaining=now<exitDeadline?static_cast<DWORD>(exitDeadline-now):0;
    if(WaitForSingleObject(process.h,remaining)!=WAIT_OBJECT_0){c.coverage=false;c.drainTimedOut=true;}
  }
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};bool queried=false;
  do {
    queried=QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr)!=FALSE;
    if(!queried || accounting.ActiveProcesses==0)break;
    if(GetTickCount64()>=exitDeadline)break;
    // Wait on our already-created process handle; no extra thread/timer/host process probe.
    WaitForSingleObject(rootProcess.h,10);
    if(c.outerExited)Sleep(1); // Bounded cleanup polling only, never an added product timeout.
  } while(GetTickCount64()<exitDeadline);
  c.remainingActiveProcesses=queried?accounting.ActiveProcesses:0;
  if(!queried || accounting.ActiveProcesses!=0){c.coverage=false;c.cleanupForced=true;}
  if(c.cleanupForced)job.reset();
  if(!save(output.h,c.summary(c.coverage && !c.writeFailed?"finished":"incomplete")))c.writeFailed=true;
  // Observation failure belongs to the separate artifact/caller verdict, not product status.
  return c.outerExited?c.exitCode:125;
}
}
int wmain(int argc,wchar_t** argv){
  // Last-resort collector exception: OS closes the non-inherited KILL_ON_JOB_CLOSE handle.
  // RAII handles unwind first; own-tree cleanup never targets a host-wide PID list.
  DWORD status=125;try{status=run(argc,argv);}catch(...){status=125;}
  ExitProcess(status); // Preserve full DWORD (including 0xC0000005).
}
