// Compiled with the already reviewed NativeController.cs; no Windows execution in preparation.
using System;
using System.IO;
using System.Diagnostics;
using System.Security.Cryptography;
namespace Sec002Fixture {
 public sealed class NodeResult {
  public string Mode,Phase,Failure;
  public uint Pid,Active,ActiveBeforeControl; public uint? Status;
  public int ReadyCount;public long ElapsedMs,StdoutBytes,StderrBytes;
  public bool StdoutEof,StderrEof,StdoutPattern,StderrPattern,ExpectedTimeout,CollectorOnlyKilled,FallbackJobKill,CleanupComplete,Forced,TimedOut;
 }
 public static class NodeController {
  const string CaptureHash="6bd0ac325ba631b1fdbc213708fdab08f6877efdb48d6fa7784787b2493ee7a5";
  const string ScriptHash="8cef9067dddaf4b8a1961d274c551a7195b3413393589a58d5c5766f02e763c3";
  static FileStream Lock(string path,string hash){var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);try{using(var s=SHA256.Create()){if(BitConverter.ToString(s.ComputeHash(f)).Replace("-","").ToLowerInvariant()!=hash)throw new NativeFailure("identity");}return f;}catch{f.Dispose();throw;}}
  static bool Drain(Owned pipe,ref bool eof,ref long count,ref bool pattern,byte value){
   if(eof)return true;uint available;if(!N.PeekNamedPipe(pipe.H,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)){if(System.Runtime.InteropServices.Marshal.GetLastWin32Error()==109){eof=true;return true;}return false;}
   if(available==0)return true;if(count+available>2097152)throw new NativeFailure("stdio_overflow");byte[] b=new byte[Math.Min(available,16384)];uint read;if(!N.ReadFile(pipe.H,b,(uint)b.Length,out read,IntPtr.Zero))return false;
   for(uint i=0;i<read;i++)if(b[i]!=value)pattern=false;count+=read;return true;
  }
  static int Ready(string cwd,string phase){int n=0;foreach(string role in new string[]{"root","child","grand"})if(File.Exists(Path.Combine(cwd,role+"."+phase+".receipt.json")))n++;return n;}
  public static NodeResult Run(string capture,string node,string nodeHash,string script,string mode,string phase,string cwd,string rawJson){
   if((mode!="handoff"&&mode!="timeout"&&mode!="collector-kill")||(phase!="baseline"&&phase!="wrapped")||(phase=="baseline"&&mode!="handoff")||nodeHash.Length!=64)throw new NativeFailure("fixed_plan");
   var r=new NodeResult{Mode=mode,Phase=phase,StdoutPattern=true,StderrPattern=true};var clock=Stopwatch.StartNew();
   using(var c=Lock(capture,CaptureHash))using(var n=Lock(node,nodeHash))using(var s=Lock(script,ScriptHash))using(var job=N.Job())using(var input=N.Nul(0x80000000)){
    Owned ro,wo,re,we;N.Pipe(out ro,out wo);try{N.Pipe(out re,out we);}catch{ro.Dispose();wo.Dispose();throw;}
    using(ro)using(wo)using(re)using(we){Owned process=null;
     try{
      if(!N.SetHandleInformation(ro.H,1,0)||!N.SetHandleInformation(re.H,1,0))throw new NativeFailure("pipe_inheritance");
      string[] target=new string[]{script,mode,"root","","space value","q\"uote","slash\\","space end\\","two\\\\\"q","雪の白 こんにちは"};
      string app=node;string[] args=target;
      if(phase=="wrapped"){app=capture;args=new string[target.Length+4];args[0]="cli-idempotent";args[1]="2";args[2]=rawJson;args[3]=node;Array.Copy(target,0,args,4,target.Length);}
      var pi=N.Launch(app,args,cwd,job,input.H,wo.H,we.H);r.Pid=pi.pid;process=new Owned(pi.process);N.CloseHandle(pi.thread);wo.Dispose();we.Dispose();input.Dispose();
      long controlAt=-1;
      while(clock.ElapsedMilliseconds<15000){
       if(!Drain(ro,ref r.StdoutEof,ref r.StdoutBytes,ref r.StdoutPattern,0x53)||!Drain(re,ref r.StderrEof,ref r.StderrBytes,ref r.StderrPattern,0x45))throw new NativeFailure("pipe_read");
       r.ReadyCount=Ready(cwd,phase);uint active;bool zero=N.ActiveZero(job,out active);r.Active=active;
       if(mode=="collector-kill"&&!r.CollectorOnlyKilled&&r.ReadyCount==3&&active==4){r.ActiveBeforeControl=active;if(!N.TerminateProcess(process.H,126))throw new NativeFailure("collector_kill");r.CollectorOnlyKilled=true;controlAt=clock.ElapsedMilliseconds;}
       if(mode=="timeout"&&!r.ExpectedTimeout&&clock.ElapsedMilliseconds>=5000){if(r.ReadyCount!=3||active!=4)throw new NativeFailure("tree_not_ready");r.ActiveBeforeControl=active;r.TimedOut=true;r.ExpectedTimeout=true;r.Forced=true;if(!N.TerminateJobObject(job.H,125))throw new NativeFailure("timeout_kill");controlAt=clock.ElapsedMilliseconds;}
       uint wait=N.WaitForSingleObject(process.H,0);if(wait==0){uint code;if(!N.GetExitCodeProcess(process.H,out code))throw new NativeFailure("exit_code");r.Status=code;}else if(wait!=258)throw new NativeFailure("process_wait");
       if(r.Status.HasValue&&r.StdoutEof&&r.StderrEof&&zero){r.CleanupComplete=true;break;}
       // Finite post-control window; do not silently fall back and call it collector-death success.
       if(controlAt>=0&&clock.ElapsedMilliseconds-controlAt>=3000)throw new NativeFailure("controlled_cleanup_deadline");
       System.Threading.Thread.Sleep(5);
      }
      if(!r.CleanupComplete)throw new NativeFailure("mode_budget");
     }catch(NativeFailure error){r.Failure=error.Code;}
     finally{
      if(!r.CleanupComplete){r.Forced=true;r.FallbackJobKill=true;N.TerminateJobObject(job.H,125);var cleanup=Stopwatch.StartNew();uint active=uint.MaxValue;
       while(cleanup.ElapsedMilliseconds<3000){try{Drain(ro,ref r.StdoutEof,ref r.StdoutBytes,ref r.StdoutPattern,0x53);Drain(re,ref r.StderrEof,ref r.StderrBytes,ref r.StderrPattern,0x45);}catch{r.Failure="cleanup_read";}
        bool zero=N.ActiveZero(job,out active);if(process!=null&&N.WaitForSingleObject(process.H,0)==0){uint code;if(N.GetExitCodeProcess(process.H,out code))r.Status=code;}
        if(zero&&r.StdoutEof&&r.StderrEof){r.CleanupComplete=true;break;}System.Threading.Thread.Sleep(5);
       }r.Active=active;
      }
      if(process!=null)process.Dispose();r.ElapsedMs=clock.ElapsedMilliseconds;
     }
    }
   }return r;
  }
 }
}
