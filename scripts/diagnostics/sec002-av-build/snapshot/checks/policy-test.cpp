#include "../src/policy.hpp"
#include <cassert>
#include <iostream>
int main(){
  using namespace sec002;unsigned checks=0;
  auto check=[&](bool b){assert(b);++checks;};
  check(target(L"cli-idempotent",2));check(target(L"cli-recovery",3));check(!target(L"cli-idempotent",3));check(!target(L"other",2));
  Startup s;auto d=exception(s,kBreakpoint,true,true,true);check(d.loader&&d.disposition==kContinue&&!d.startupUnknown);
  d=exception(s,kBreakpoint,true,true,true);check(!d.loader&&d.disposition==kNotHandled);
  for(bool first:{false,true}){Startup a;auto x=exception(a,kAv,first,true,true);check(x.disposition==kNotHandled&&x.captureAv==!first&&x.startupUnknown);}
  for(unsigned mask=0;mask<8;++mask){Startup a;bool first=mask&1,thread=mask&2,address=mask&4;auto x=exception(a,kBreakpoint,first,thread,address);check(x.loader==(mask==7));}
  Startup a;auto x=exception(a,0x406d1388u,true,true,true);check(x.disposition==kNotHandled&&x.startupUnknown);
  check(access(0)=="read");check(access(1)=="write");check(access(8)=="execute");check(access(7)=="unknown");
  check(quote(L"")==L"\"\"");check(quote(L"simple")==L"simple");check(quote(L"a b")==L"\"a b\"");
  check(quote(L"a\"b")==L"\"a\\\"b\"");check(quote(L"a b\\")==L"\"a b\\\\\"");check(quote(L"a\\b")==L"a\\b");
  check(span(7,3,10));check(!span(7,4,10));check(!span(UINT64_MAX,1,10));check(span(10,0,10));
  check(kFrames==32&&kOutputLimit==65536&&kProcesses==64&&kThreads==4096&&kModules==1024);
  std::cout<<"{\"kind\":\"portable-policy-only\",\"checks\":"<<checks<<",\"passed\":"<<checks<<",\"windowsValidated\":false}\n";
}
