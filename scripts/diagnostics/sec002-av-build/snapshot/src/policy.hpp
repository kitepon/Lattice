#pragma once
#include <cstdint>
#include <string>
#include <string_view>
namespace sec002 {
constexpr std::uint32_t kAv = 0xc0000005u, kBreakpoint = 0x80000003u;
constexpr std::uint32_t kContinue = 0x00010002u, kNotHandled = 0x80010001u;
constexpr std::size_t kOutputLimit=65536, kFrames=32, kProcesses=64, kThreads=4096, kModules=1024;
struct Startup { bool firstException=true, loaderSeen=false; };
inline bool target(std::wstring_view id, unsigned order) {
  return (id==L"cli-idempotent" && order==2) || (id==L"cli-recovery" && order==3);
}
struct Decision { std::uint32_t disposition; bool loader; bool startupUnknown; bool captureAv; };
inline Decision exception(Startup& state, std::uint32_t code, bool firstChance,
                          bool initialThread, bool verifiedNtdllExecutableInt3) {
  const bool loader = state.firstException && firstChance && code==kBreakpoint &&
                      initialThread && verifiedNtdllExecutableInt3;
  const bool unknown = state.firstException && !loader;
  state.firstException=false;
  if(loader) state.loaderSeen=true;
  return {loader?kContinue:kNotHandled,loader,unknown,!firstChance && code==kAv};
}
inline std::string_view access(std::uint64_t kind) {
  return kind==0?"read":kind==1?"write":kind==8?"execute":"unknown";
}
// Same quoting algorithm as the ordinary (non-verbatim) libuv Windows argv path.
// Exact equivalence for the pinned Node/libuv version remains a Windows fixture gate.
inline std::wstring quote(std::wstring_view s) {
  if(!s.empty() && s.find_first_of(L" \t\"")==std::wstring_view::npos) return std::wstring(s);
  std::wstring out=L"\""; std::size_t slash=0;
  for(wchar_t c:s) {
    if(c==L'\\') { ++slash; continue; }
    out.append(slash*(c==L'"'?2:1), L'\\'); slash=0;
    if(c==L'"') out+=L'\\';
    out+=c;
  }
  out.append(slash*2,L'\\'); return out+L'"';
}
inline bool span(std::uint64_t offset, std::uint64_t size, std::uint64_t bound) {
  return offset<=bound && size<=bound-offset;
}
}
