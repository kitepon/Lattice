param(
  [Parameter(Mandatory=$true)][int]$ChildPid,
  [Parameter(Mandatory=$true)][string]$BirthFileTime,
  [uint32]$RequestedExitCode = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DashboardOwnedProcess {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint exit);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
# PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | PROCESS_TERMINATE. No debug privilege.
$handle = [DashboardOwnedProcess]::OpenProcess(0x101001, $false, $ChildPid)
if ($handle -eq [IntPtr]::Zero) { throw 'DASHBOARD_CHILD_OPEN_FAILED' }
try {
  [long]$birth=0; [long]$ended=0; [long]$kernel=0; [long]$user=0
  if (-not [DashboardOwnedProcess]::GetProcessTimes($handle,[ref]$birth,[ref]$ended,[ref]$kernel,[ref]$user)) { throw 'DASHBOARD_CHILD_BIRTH_FAILED' }
  if ($birth.ToString() -cne $BirthFileTime) { throw 'DASHBOARD_CHILD_IDENTITY_MISMATCH' }
  $alreadyExited = [DashboardOwnedProcess]::WaitForSingleObject($handle,0) -eq 0
  $requested = $false
  if (-not $alreadyExited) {
    if (-not [DashboardOwnedProcess]::TerminateProcess($handle,$RequestedExitCode)) {
      # A racing natural exit may win. Verify it with this handle, never invent the requested value.
      if ([DashboardOwnedProcess]::WaitForSingleObject($handle,0) -ne 0) { throw 'DASHBOARD_CHILD_TERMINATE_FAILED' }
    } else { $requested = $true }
  }
  if ([DashboardOwnedProcess]::WaitForSingleObject($handle,5000) -ne 0) { throw 'DASHBOARD_CHILD_WAIT_FAILED' }
  [uint32]$actual=0
  if (-not [DashboardOwnedProcess]::GetExitCodeProcess($handle,[ref]$actual)) { throw 'DASHBOARD_CHILD_EXIT_READ_FAILED' }
  [ordered]@{schema='lattice.dashboard_process_control.v1';pid=$ChildPid;birth_filetime=$BirthFileTime;
    termination_requested=$requested;requested_exit_code=$RequestedExitCode;actual_exit_code=$actual;
    actual_exit_hex=('0x{0:X8}' -f $actual);source='GetExitCodeProcess'} | ConvertTo-Json -Compress
} finally { [void][DashboardOwnedProcess]::CloseHandle($handle) }
