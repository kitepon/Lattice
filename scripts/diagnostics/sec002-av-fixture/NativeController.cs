// Job-local fixture controller source; preparation only. No host PID enumeration/attach.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Security.Cryptography;
namespace Sec002Fixture {
 public sealed class NativeFailure:Exception { public string Code; public NativeFailure(string code):base(code){Code=code;} }
 public sealed class Owned:IDisposable {
  public IntPtr H; public Owned(IntPtr h){H=h;} public void Dispose(){if(H!=IntPtr.Zero && H!=new IntPtr(-1)){N.CloseHandle(H);H=IntPtr.Zero;}}
 }
 internal static class N {
  [StructLayout(LayoutKind.Sequential)] internal struct SA {public int size;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct SI {public uint cb;public IntPtr reserved,desktop,title;public uint x,y,xs,ys,cx,cy,fill,flags;public ushort show,extra;public IntPtr extraPtr,input,output,error;}
  [StructLayout(LayoutKind.Sequential)] internal struct SIX {public SI startup;public IntPtr list;}
  [StructLayout(LayoutKind.Sequential)] internal struct PI {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] internal struct BASIC {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,schedule;}
  [StructLayout(LayoutKind.Sequential)] internal struct IO {public ulong a,b,c,d,e,f;}
  [StructLayout(LayoutKind.Sequential)] internal struct LIMIT {public BASIC basic;public IO io;public UIntPtr a,b,c,d;}
  [StructLayout(LayoutKind.Sequential)] internal struct ACCOUNT {public long a,b,c,d;public uint faults,total,active,terminated;}
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern IntPtr CreateJobObjectW(IntPtr sa,IntPtr name);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool SetInformationJobObject(IntPtr job,int kind,ref LIMIT data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNT data,uint size,IntPtr needed);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]internal static extern IntPtr CreateFileW(string path,uint access,uint share,ref SA sa,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")]internal static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]internal static extern bool CreateProcessW(string app,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr environment,string cwd,ref SIX startup,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,uint count,IntPtr read,out uint available,IntPtr left);
  [DllImport("kernel32.dll",SetLastError=true)]internal static extern bool ReadFile(IntPtr pipe,byte[] buffer,uint count,out uint read,IntPtr overlapped);
  internal static Owned Job(){var j=new Owned(CreateJobObjectW(IntPtr.Zero,IntPtr.Zero));if(j.H==IntPtr.Zero)throw new NativeFailure("job_create");
   var l=new LIMIT();l.basic.flags=0x2000;if(!SetInformationJobObject(j.H,9,ref l,(uint)Marshal.SizeOf(typeof(LIMIT)))){j.Dispose();throw new NativeFailure("job_limits");}return j;}
  internal static string Quote(string s){if(s.Length>0 && s.IndexOfAny(new char[]{' ','\t','"'})<0)return s;var b=new StringBuilder("\"");int slash=0;foreach(char c in s){if(c=='\\'){slash++;continue;}b.Append('\\',slash*(c=='"'?2:1));slash=0;if(c=='"')b.Append('\\');b.Append(c);}b.Append('\\',slash*2);return b.Append('"').ToString();}
  internal static Owned Nul(uint access){var sa=new SA{size=Marshal.SizeOf(typeof(SA)),inherit=true};var h=new Owned(CreateFileW("NUL",access,3,ref sa,3,0,IntPtr.Zero));if(h.H==new IntPtr(-1))throw new NativeFailure("stdio_create");return h;}
  internal static void Pipe(out Owned read,out Owned write){var sa=new SA{size=Marshal.SizeOf(typeof(SA)),inherit=true};IntPtr r,w;if(!CreatePipe(out r,out w,ref sa,4096))throw new NativeFailure("pipe_create");read=new Owned(r);write=new Owned(w);}
  internal static PI Launch(string app,string[] args,string cwd,Owned job,IntPtr input,IntPtr output,IntPtr error){
   IntPtr size=IntPtr.Zero,list=IntPtr.Zero,handles=IntPtr.Zero,jobList=IntPtr.Zero;bool initialized=false;PI pi=new PI();bool created=false;
   try {InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);if(size==IntPtr.Zero)throw new NativeFailure("attribute_size");list=Marshal.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(list,2,0,ref size))throw new NativeFailure("attribute_init");initialized=true;
    handles=Marshal.AllocHGlobal(3*IntPtr.Size);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,output);Marshal.WriteIntPtr(handles,2*IntPtr.Size,error);
    if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new NativeFailure("attribute_handles");
    jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job.H);
    if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new NativeFailure("atomic_job_attribute_unavailable");
    var si=new SIX();si.startup.cb=(uint)Marshal.SizeOf(typeof(SIX));si.startup.flags=0x100;si.startup.input=input;si.startup.output=output;si.startup.error=error;si.list=list;
    var command=new StringBuilder(Quote(app));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
    if(!CreateProcessW(app,command,IntPtr.Zero,IntPtr.Zero,true,0x00080004,IntPtr.Zero,cwd,ref si,out pi))throw new NativeFailure("launch_denied_or_failed");created=true;
    bool member;if(!IsProcessInJob(pi.process,job.H,out member)||!member)throw new NativeFailure("atomic_job_membership");
    if(ResumeThread(pi.thread)==0xffffffff)throw new NativeFailure("resume_failed");return pi;
   }catch {if(created){TerminateProcess(pi.process,125);WaitForSingleObject(pi.process,2000);CloseHandle(pi.thread);CloseHandle(pi.process);}throw;}
   finally{if(initialized)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);}
  }
  internal static bool ActiveZero(Owned job,out uint count){ACCOUNT a;bool ok=QueryInformationJobObject(job.H,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero);count=ok?a.active:uint.MaxValue;return ok&&count==0;}
 }
 public sealed class Result {public uint Pid;public uint? Status;public bool TimedOut,StdoutEof,StderrEof,CleanupComplete,Forced;public uint Active;public byte[] Stdout,Stderr;public string Failure;public long ElapsedMs;}
 public sealed class Sentinel:IDisposable {
  Owned job,process,input;public uint Pid;
  public Sentinel(string node,string cwd){job=N.Job();try{Owned r,w;N.Pipe(out r,out w);input=w;using(r)using(var output=N.Nul(0x40000000))using(var error=N.Nul(0x40000000)){
   try{if(!N.SetHandleInformation(input.H,1,0))throw new NativeFailure("sentinel_handle");var pi=N.Launch(node,new string[]{"-e","process.stdin.resume()"},cwd,job,r.H,output.H,error.H);Pid=pi.pid;process=new Owned(pi.process);N.CloseHandle(pi.thread);}catch{Dispose();throw;}}}catch{Dispose();throw;}
  }
  public bool Alive(){return process!=null && N.WaitForSingleObject(process.H,0)==258;}
  public bool Stop(){if(input!=null){input.Dispose();input=null;}if(process==null)return false;if(N.WaitForSingleObject(process.H,2000)!=0)N.TerminateJobObject(job.H,125);uint active;var timer=Stopwatch.StartNew();while(timer.ElapsedMilliseconds<2000){if(N.ActiveZero(job,out active))return true;System.Threading.Thread.Sleep(5);}return false;}
  public void Dispose(){if(input!=null)input.Dispose();if(job!=null)job.Dispose();if(process!=null)process.Dispose();}
 }
 public static class Controller {
  public static bool Layouts(){return IntPtr.Size==8&&Marshal.SizeOf(typeof(N.PI))==24&&Marshal.SizeOf(typeof(N.SIX))==112&&Marshal.SizeOf(typeof(N.LIMIT))==144;}
  static bool Drain(Owned pipe,MemoryStream bytes,ref bool eof){if(eof)return true;uint available;
   if(!N.PeekNamedPipe(pipe.H,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)){if(Marshal.GetLastWin32Error()==109){eof=true;return true;}return false;}
   if(available==0)return true;if(bytes.Length+available>65536)throw new NativeFailure("stdio_overflow");byte[] b=new byte[Math.Min(available,16384)];uint n;if(!N.ReadFile(pipe.H,b,(uint)b.Length,out n,IntPtr.Zero))return false;bytes.Write(b,0,(int)n);return true;
  }
  static FileStream FixedFile(string path,string expected){var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);try{using(var sha=SHA256.Create()){string actual=BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();if(actual!=expected)throw new NativeFailure("binary_identity");}file.Position=0;return file;}catch{file.Dispose();throw;}}
  public static Result Run(string capture,string fixture,string mode,string cwd,string rawJson,int budgetMs){
   if(budgetMs<1||budgetMs>30000)throw new NativeFailure("budget_invalid");var result=new Result();var timer=Stopwatch.StartNew();
   using(var captureFile=FixedFile(capture,"6bd0ac325ba631b1fdbc213708fdab08f6877efdb48d6fa7784787b2493ee7a5"))using(var fixtureFile=FixedFile(fixture,"358ac983d9e96ccf66c56be68d322bc5733a51bcff0b985e58512840929a3a42"))using(var job=N.Job())using(var input=N.Nul(0x80000000))using(var stdout=new MemoryStream())using(var stderr=new MemoryStream()){
    Owned readOut,writeOut,readErr,writeErr;N.Pipe(out readOut,out writeOut);try{N.Pipe(out readErr,out writeErr);}catch{readOut.Dispose();writeOut.Dispose();throw;}
    using(readOut)using(writeOut)using(readErr)using(writeErr){Owned process=null;
     try{
      if(!N.SetHandleInformation(readOut.H,1,0)||!N.SetHandleInformation(readErr.H,1,0))throw new NativeFailure("pipe_inheritance");
      var pi=N.Launch(capture,new string[]{"cli-idempotent","2",rawJson,fixture,mode},cwd,job,input.H,writeOut.H,writeErr.H);result.Pid=pi.pid;process=new Owned(pi.process);N.CloseHandle(pi.thread);writeOut.Dispose();writeErr.Dispose();input.Dispose();
      bool done=false;
      while(timer.ElapsedMilliseconds<budgetMs){
       if(!Drain(readOut,stdout,ref result.StdoutEof)||!Drain(readErr,stderr,ref result.StderrEof))throw new NativeFailure("pipe_read");
       uint wait=N.WaitForSingleObject(process.H,0);if(wait==0){uint status;if(!N.GetExitCodeProcess(process.H,out status))throw new NativeFailure("exit_code");result.Status=status;done=true;}else if(wait!=258)throw new NativeFailure("process_wait");
       uint active;if(done&&result.StdoutEof&&result.StderrEof&&N.ActiveZero(job,out active)){result.CleanupComplete=true;result.Active=active;break;}System.Threading.Thread.Sleep(5);
      }
      if(!result.CleanupComplete){result.TimedOut=true;result.Failure="mode_budget";}
     }catch(NativeFailure error){result.Failure=error.Code;}
     finally{
      if(!result.CleanupComplete){result.Forced=true;N.TerminateJobObject(job.H,125);var cleanup=Stopwatch.StartNew();uint active=uint.MaxValue;while(cleanup.ElapsedMilliseconds<3000){if(N.ActiveZero(job,out active)){result.CleanupComplete=true;break;}System.Threading.Thread.Sleep(5);}result.Active=active;}
      if(process!=null)process.Dispose();result.Stdout=stdout.ToArray();result.Stderr=stderr.ToArray();result.ElapsedMs=timer.ElapsedMilliseconds;
     }
    }
   }return result;
  }
 }
}
