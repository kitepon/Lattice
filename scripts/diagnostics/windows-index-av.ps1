param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
$tools = Join-Path $output 'tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$zip = Join-Path $tools 'Procdump.zip'
Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/Procdump.zip' -OutFile $zip
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($hash -ne '5fe68e81632f13188930affff20a9a9910170bae654360850d3108cead708a2d') { throw "ProcDump archive changed: $hash" }
Expand-Archive -Path $zip -DestinationPath $tools -Force
$debugger = Join-Path $tools 'procdump64.exe'
$signature = Get-AuthenticodeSignature $debugger
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') { throw 'ProcDump signature verification failed' }
@{sha256=$hash;signatureStatus=[string]$signature.Status;signer=$signature.SignerCertificate.Subject;version=(Get-Item $debugger).VersionInfo.FileVersion} |
  ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $output 'debugger.json')
node scripts/diagnostics/windows-index-av.mjs $output $debugger
if ($LASTEXITCODE -ne 0) { throw "Diagnostic harness exited $LASTEXITCODE" }
# Read only application-crash events whose faulting PID belongs to these
# fixture traces. The message/body and unrelated application events are omitted.
$pids = [Collections.Generic.HashSet[int]]::new()
Get-ChildItem (Join-Path $output 'traces') -Filter '*.jsonl' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.BaseName -match '^(\d+)-') { [void]$pids.Add([int]$Matches[1]) }
}
$events = @()
try {
  Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000;StartTime=(Get-Date).AddMinutes(-25)} -ErrorAction Stop | ForEach-Object {
    [xml]$xml = $_.ToXml(); $fields = @{}
    $xml.Event.EventData.Data | ForEach-Object { $fields[$_.Name] = $_.'#text' }
    $faultPid = 0
    if ($fields.ProcessId -match '^0x') { $faultPid = [Convert]::ToInt32($fields.ProcessId.Substring(2),16) }
    elseif ($fields.ProcessId) { [int]::TryParse($fields.ProcessId,[ref]$faultPid) | Out-Null }
    if ($pids.Contains($faultPid)) { $events += @{at=$_.TimeCreated.ToUniversalTime().ToString('o');pid=$faultPid;fields=$fields} }
  }
} catch { @{status='unavailable';reason=$_.Exception.Message} | ConvertTo-Json | Set-Content (Join-Path $output 'event-read-status.json') }
ConvertTo-Json -InputObject $events -Depth 8 | Set-Content -Encoding utf8 (Join-Path $output 'crash-events.json')
