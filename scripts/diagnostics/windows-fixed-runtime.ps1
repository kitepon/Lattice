param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path $output) { throw 'Fixed-runtime comparison requires a new owned output directory' }
New-Item -ItemType Directory $output | Out-Null
$tools = Join-Path $output 'tools'
New-Item -ItemType Directory $tools | Out-Null
$baselineNode = (& node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or $baselineNode -ne '24.20.0') { throw "The original host Node changed: $baselineNode" }
function Get-CheckedFile([string]$Uri, [string]$File, [string]$Hash, [hashtable]$Headers = @{}) {
  Invoke-WebRequest -Uri $Uri -OutFile $File -Headers $Headers -TimeoutSec 240
  if ((Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant() -ne $Hash) { throw "Fixed comparison input mismatch: $File" }
}
$fixedNode = Join-Path $tools 'node.exe'
Get-CheckedFile 'https://nodejs.org/dist/v24.22.0/win-x64/node.exe' $fixedNode 'ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c'
if (-not $env:GH_TOKEN) { throw 'Read access to fixed saved diagnostic binaries is required' }
$artifact = Join-Path $tools 'probe-artifact.zip'
Get-CheckedFile 'https://api.github.com/repos/kitepon/Lattice/actions/artifacts/12566363578/zip' $artifact 'd9f832252acc037d39b02007893ff7c5f3f61c7a04debc86ddacb4dd61c26680' @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json' }
$probe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../heap-probe-build'))
if (Test-Path $probe) { throw 'Refuse to overwrite an existing probe build directory' }
New-Item -ItemType Directory $probe | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($artifact)
try {
  foreach ($name in @('heap-probe.node', 'heap-probe.pdb', 'heap-dump-helper.exe', 'heap-dump-helper.pdb', 'build.json')) {
    $entry = $archive.GetEntry('heap-probe-build/' + $name)
    if (-not $entry) { throw "Fixed artifact lacks $name" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $probe $name))
  }
} finally { $archive.Dispose() }
$addon = Join-Path $probe 'heap-probe.node'
$helper = Join-Path $probe 'heap-dump-helper.exe'
if ((Get-FileHash -Algorithm SHA256 $addon).Hash.ToLowerInvariant() -ne 'fcca8560da678d00337c5dabb7f25700ea17cd49df275c8be1deaff2a46863d8') { throw 'Saved NAPI addon mismatch' }
if ((Get-FileHash -Algorithm SHA256 $helper).Hash.ToLowerInvariant() -ne '2a23b9486c2664d3b910be8692eb10b5974f1f9dbeef2485ff4934daa8f64111') { throw 'Saved helper mismatch' }
$zip = Join-Path $tools 'Procdump.zip'
Get-CheckedFile 'https://download.sysinternals.com/files/Procdump.zip' $zip '5fe68e81632f13188930affff20a9a9910170bae654360850d3108cead708a2d'
Expand-Archive $zip (Join-Path $tools 'procdump')
$debugger = Join-Path $tools 'procdump/procdump64.exe'
$signature = Get-AuthenticodeSignature $debugger
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') { throw 'Saved comparison debugger signature failed' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
function Invoke-OwnedNode([string[]]$Arguments, [string]$Label, [int]$TimeoutMs = 600000) {
  $privateHome = Join-Path $output ('home-' + $Label)
  New-Item -ItemType Directory $privateHome | Out-Null
  $start = [Diagnostics.ProcessStartInfo]::new($fixedNode)
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $repo
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment.Clear()
  foreach ($key in @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $start.Environment[$key] = $value }
  }
  foreach ($key in @('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP')) { $start.Environment[$key] = $privateHome }
  $start.Environment['LATTICE_RUNTIME_ERROR_REPORTING'] = '0'
  $start.Environment['LATTICE_SENSOR_NO_DAEMON'] = '1'
  $start.Environment['NO_COLOR'] = '1'
  $start.Environment['GITHUB_SHA'] = $env:GITHUB_SHA
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Owned fixed Node start failed' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $timedOut = -not $process.WaitForExit($TimeoutMs)
  if ($timedOut) { $process.Kill($true); $process.WaitForExit() }
  $text = $stdout.GetAwaiter().GetResult()
  $errorText = $stderr.GetAwaiter().GetResult()
  $text | Set-Content -Encoding utf8 (Join-Path $output ($Label + '-stdout.txt'))
  $errorText | Set-Content -Encoding utf8 (Join-Path $output ($Label + '-stderr.txt'))
  @{ Label=$Label; Pid=$process.Id; Exit=$process.ExitCode; TimedOut=$timedOut; NodeExecutable=$fixedNode; Arguments=$Arguments } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $output ($Label + '-launch.json'))
  if ($timedOut -or $process.ExitCode -ne 0) { throw "Owned fixed Node operation failed: $Label" }
  return $text
}
$runtime = Invoke-OwnedNode @('-p', 'JSON.stringify({node:process.versions.node,v8:process.versions.v8,napi:process.versions.napi,execPath:process.execPath})') 'runtime' 15000
$runtimeData = $runtime | ConvertFrom-Json
if ($runtimeData.node -ne '24.22.0') { throw 'Wrong fixed runtime executed' }
@{ BaselineNode=$baselineNode; FixedRuntime=$runtimeData; FixedNodeSha256=(Get-FileHash -Algorithm SHA256 $fixedNode).Hash.ToLowerInvariant(); SourceArtifact=12566363578; AddonHash=(Get-FileHash -Algorithm SHA256 $addon).Hash.ToLowerInvariant(); HelperHash=(Get-FileHash -Algorithm SHA256 $helper).Hash.ToLowerInvariant(); DbgHelpHash=(Get-FileHash -Algorithm SHA256 (Join-Path $env:SystemRoot 'System32/dbghelp.dll')).Hash.ToLowerInvariant(); NtdllHash=(Get-FileHash -Algorithm SHA256 (Join-Path $env:SystemRoot 'System32/ntdll.dll')).Hash.ToLowerInvariant(); Os=[Environment]::OSVersion.VersionString; HostNodeUnchanged=$true; GlobalPathUnchanged=$true; Note='Changed-runtime evidence, not proof that the original access violation has the same cause' } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $output 'inputs.json')
# New-runtime NAPI/helper compatibility is a mechanism check, not a fault trial.
Invoke-OwnedNode @((Join-Path $PSScriptRoot 'verify-owned-minidump.mjs'), $addon, $helper, (Join-Path $output 'healthy-fixed-runtime')) 'healthy' 30000 | Write-Output
Invoke-OwnedNode @((Join-Path $PSScriptRoot 'windows-index-av.mjs'), (Join-Path $output 'heapwindow'), $debugger, 'heapwindow') 'heapwindow' | Write-Output
$heapCommands = @(Get-Content (Join-Path $output 'heapwindow/commands.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
$heapFaults = @($heapCommands | Where-Object { $_.code -ne 0 -or $_.timedOut -or $_.error -or $_.exceptionCode -or $_.diagnosticHeapInvalid -or -not $_.debuggeeExitObserved })
$heapRuntime = Get-Content (Join-Path $output 'heapwindow/runtime.json') -Raw | ConvertFrom-Json
if ($heapRuntime.node -ne '24.22.0') { throw 'The real pool did not use the fixed Node' }
if ($heapCommands.Count -ne 16 -or $heapFaults.Count) {
  @{ Status='native-comparison-not-accepted'; Commands=$heapCommands.Count; Failures=$heapFaults; NormalOriginalCycleRun=$false } | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $output 'comparison.json')
  throw 'Changed runtime still failed or did not complete; preserve native evidence and do not run the normal cycle'
}
Invoke-OwnedNode @((Join-Path $PSScriptRoot 'windows-index-av.mjs'), (Join-Path $output 'normal'), $debugger, 'runtimefixed-normal') 'normal' 120000 | Write-Output
$normalCommands = @(Get-Content (Join-Path $output 'normal/commands.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
$normalGraph = @(Get-Content (Join-Path $output 'normal/graph-counts.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
$normalRuntime = Get-Content (Join-Path $output 'normal/runtime.json') -Raw | ConvertFrom-Json
$normalFaults = @($normalCommands | Where-Object { $_.code -ne 0 -or $_.timedOut -or $_.error -or $_.signal })
$normalAccepted = $normalCommands.Count -eq 3 -and $normalFaults.Count -eq 0 -and $normalGraph.Count -eq 1 -and $normalGraph[0].consistent -eq $true -and $normalRuntime.node -eq '24.22.0'
@{ Status=$(if ($normalAccepted) {'bounded-comparison-completed'} else {'normal-cycle-failed'}); HeapCommands=$heapCommands.Count; NativeFaults=$heapFaults.Count; NormalCommands=$normalCommands.Count; NormalAccepted=$normalAccepted; OriginalAVSameCauseProven=$false; RootCauseVerdict='Requires source/heap provenance and runtime contract repair review; no-fault counts alone are not proof' } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $output 'comparison.json')
if (-not $normalAccepted) { throw 'Original normal input cycle did not meet its actual completion and graph assertions' }
if ((& node -p 'process.versions.node').Trim() -ne $baselineNode) { throw 'Host Node changed during isolated comparison' }
