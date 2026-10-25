param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path $output) { throw 'Offline analysis requires a new owned output directory' }
New-Item -ItemType Directory $output | Out-Null
function Get-CheckedFile([string]$Uri, [string]$File, [string]$Hash, [hashtable]$Headers = @{}) {
  Invoke-WebRequest -Uri $Uri -OutFile $File -Headers $Headers -TimeoutSec 240
  $actual = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant()
  if ($actual -ne $Hash) { throw "Offline analysis input hash mismatch: $File" }
}
$bundle = Join-Path $output 'windbg.msixbundle'
Get-CheckedFile 'https://windbg.download.prss.microsoft.com/dbazure/prod/1-2610-1001-0/windbg.msixbundle' $bundle '4662ae17bc0dc77db987b89cccea32c30058baa06268f861d09e0ab4e4f45c20'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($bundle)
try {
  $entry = $archive.GetEntry('windbg_win-x64.msix')
  if (-not $entry) { throw 'Fixed WinDbg x64 payload is absent' }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $output 'windbg-x64.msix'))
} finally { $archive.Dispose() }
$msix = Join-Path $output 'windbg-x64.msix'
if ((Get-FileHash -Algorithm SHA256 $msix).Hash.ToLowerInvariant() -ne '959c4ec033e2d00f7ed75646e4d352cc7cff6de33f494fd5dccb83819fe64e7a') { throw 'WinDbg payload mismatch' }
$tools = Join-Path $output 'tools'
New-Item -ItemType Directory $tools | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($msix)
try {
  foreach ($entry in $archive.Entries) {
    if (-not $entry.FullName.StartsWith('amd64/') -or $entry.FullName.EndsWith('/')) { continue }
    $destination = [IO.Path]::GetFullPath((Join-Path $tools $entry.FullName))
    if (-not $destination.StartsWith($tools + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'WinDbg archive path escaped output' }
    New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)
  }
} finally { $archive.Dispose() }
$artifact = Join-Path $output 'artifact.zip'
if (-not $env:GH_TOKEN) { throw 'Read access to the fixed saved artifact is required' }
Get-CheckedFile 'https://api.github.com/repos/kitepon/Lattice/actions/artifacts/12566363578/zip' $artifact 'd9f832252acc037d39b02007893ff7c5f3f61c7a04debc86ddacb4dd61c26680' @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json' }
$evidence = Join-Path $output 'evidence'
Expand-Archive $artifact $evidence
$relativeDump = 'heap-check-output/traces/lattice-av-fe4d0e03-a23a-4566-9463-7b71a73991da/owned-44076.dmp'
$dump = Join-Path $evidence $relativeDump
if (-not (Test-Path $dump)) { throw 'The fixed saved dump is missing' }
$receipt = Get-Content ($dump + '.json') -Raw | ConvertFrom-Json
if ($receipt.pid -ne 44076 -or $receipt.phase -ne 77 -or -not $receipt.ok) { throw 'Saved dump receipt mismatch' }
$nodeZip = Join-Path $output 'node-pdb.zip'
Get-CheckedFile 'https://nodejs.org/download/release/v24.20.0/win-x64/node_pdb.zip' $nodeZip '27a5ed0f346bb2ca58e6429a2f0082016433126e80c646b0def96cb547422ea1'
$nodeSymbols = Join-Path $output 'node-symbols'
Expand-Archive $nodeZip $nodeSymbols
$nodeExe = Join-Path $nodeSymbols 'node.exe'
Get-CheckedFile 'https://nodejs.org/download/release/v24.20.0/win-x64/node.exe' $nodeExe '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'
$cache = Join-Path $output 'symbols'
$homeDirectory = Join-Path $output 'home'
New-Item -ItemType Directory $cache, $homeDirectory | Out-Null
$cdb = Join-Path $tools 'amd64/cdb.exe'
if ((Get-FileHash -Algorithm SHA256 $cdb).Hash.ToLowerInvariant() -ne 'a9e81c9051a7902fbd8ebd8d348cf83c96f2d8bffd6c2174171a23cef16bb039') { throw 'CDB mismatch' }
$extension = Join-Path $tools 'amd64/winext/ext.dll'
# CDB's command parser interprets backslashes inside quoted arguments.
$extensionCommandPath = $extension.Replace('\', '/')
$commands = Join-Path $output 'commands.txt'
@('.symopt- 0x40',
  '.reload /f node.exe',
  'lmv m node',
  '.echo LATTICE_CONTEXT_TYPES_BEGIN',
  'dt node!node::ContextEmbedderIndex',
  'x node!node::ContextEmbedderTag::*',
  'dps node!node::ContextEmbedderTag::kNodeContextTagPtr L1',
  'dt node!v8::internal::EmbedderDataArray',
  'dt node!v8::internal::Map',
  'dt node!v8::internal::NativeContext',
  'dt node!node::Environment 0x1c3d5018fe0',
  '.echo LATTICE_CONTEXT_TYPES_END',
  '.echo LATTICE_CONTEXT_BYTES_BEGIN',
  'dq 0x16ba1704060 L2b',
  'dq 0x262a5bc10d0 L10',
  'dq 0x262a5bc32e0 L8',
  'dq 0x1c3d5018fe0 L10',
  '.echo LATTICE_CONTEXT_BYTES_END',
  '.echo LATTICE_OFFLINE_ANALYSIS_END',
  'q') | Set-Content -Encoding ascii $commands
$symbolPath = "$nodeSymbols;$(Join-Path $evidence 'heap-probe-build');srv*$cache*https://msdl.microsoft.com/download/symbols"
$start = [Diagnostics.ProcessStartInfo]::new($cdb)
$start.UseShellExecute = $false
$start.WorkingDirectory = Join-Path $tools 'amd64'
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Environment.Clear()
foreach ($key in @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT')) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($value) { $start.Environment[$key] = $value }
}
foreach ($key in @('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP')) { $start.Environment[$key] = $homeDirectory }
foreach ($argument in @('-sins', '-y', $symbolPath, '-i', $nodeSymbols, '-z', $dump, '-cf', $commands)) { $start.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
if (-not $process.Start()) { throw 'Offline CDB start failed' }
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$timedOut = -not $process.WaitForExit(300000)
if ($timedOut) { $process.Kill($true); $process.WaitForExit() }
$textOutput = $stdout.GetAwaiter().GetResult()
$textError = $stderr.GetAwaiter().GetResult()
$textOutput | Set-Content -Encoding utf8 (Join-Path $output 'cdb-stdout.txt')
$textError | Set-Content -Encoding utf8 (Join-Path $output 'cdb-stderr.txt')
$completed = $textOutput.Contains('LATTICE_OFFLINE_ANALYSIS_END')
$referenceMatch = [regex]::Match($textOutput, '(?ms)^LATTICE_CONTEXT_BYTES_BEGIN\r?\n(.*?)^LATTICE_CONTEXT_BYTES_END\r?$')
$memoryLines = if ($referenceMatch.Success) {
  @($referenceMatch.Groups[1].Value -split '\r?\n' | Where-Object { $_ -match '^\s*[0-9a-f]{8}`[0-9a-f]{8}\s+[0-9a-f]{8}`[0-9a-f]{8}' })
} else { @() }
$missingQueries = @([regex]::Matches($textOutput, '(?im)^.*(?:symbol.*not found|could not be found|could not resolve|could not be resolved|unable to resolve|type information missing).*$') | ForEach-Object { $_.Value })
@{ Kind='saved-context-reference-analysis'; FixedSourceRun=40111138520; FixedArtifact=12566363578;
  DumpSha256=(Get-FileHash -Algorithm SHA256 $dump).Hash.ToLowerInvariant();
  ToolVersion=(Get-Item $cdb).VersionInfo.FileVersion; Exit=$process.ExitCode; TimedOut=$timedOut;
  CommandSequenceCompleted=$completed; MemoryLinesRead=$memoryLines.Count;
  MissingTypeQueries=$missingQueries; TypeCompleteness='requires exact raw-output review';
  ReferenceVerdict='requires matching type/constants and saved-byte comparison; not allocation or write-PC proof';
  Commands=(Get-Content $commands); NoLiveTarget=$true } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $output 'analysis.json')
if ($timedOut -or $process.ExitCode -ne 0 -or -not $completed -or $memoryLines.Count -lt 25) { throw 'Saved reference read did not complete; inspect preserved raw output' }
