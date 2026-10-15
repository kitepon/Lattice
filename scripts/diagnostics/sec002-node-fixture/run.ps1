# Preparation only. Future Windows execution requires a separate explicit permission.
param([Parameter(Mandatory=$true)][string]$SourceHead,[Parameter(Mandatory=$true)][string]$WorkflowHead,[Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$publish=Join-Path $Root 'publish';$private=Join-Path $Root 'quarantine';$incoming=Join-Path $Root 'incoming'
$state=[ordered]@{schema='sec002-node-controller-v1';sourceHead=$SourceHead;workflowHead=$WorkflowHead;status='incomplete';sourceValidAtEntry=$false;sourceValidAtEnd=$false;artifactVerified=$false;targetNodeIdentityVerified=$false;targetNodeSha256=$null;scriptSha256=$null;sentinelAlive=$false;sentinelCleanupComplete=$false;handoffAdmitted=$false;cases=@();compileDiagnostics=@();failureCode=$null;stackImplemented=$false;productExecuted=$false;additionalNativeFixtureUsed=$false}
$sentinel=$null
function Save {$state | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $publish 'node-summary.json') -Encoding utf8}
try {
 if($env:GITHUB_SHA -cne $WorkflowHead -or $env:GITHUB_WORKFLOW_SHA -cne $WorkflowHead -or $env:GITHUB_REF -cne 'refs/heads/snowwhite/sec002-node-fixture' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch'){throw 'workflow_entry'}
 if(!(Test-Path -LiteralPath $publish -PathType Container) -or (Test-Path -LiteralPath $private)){throw 'fresh_directory_required'}
 New-Item -ItemType Directory -Path $private | Out-Null;Save
 & node (Join-Path $repo 'scripts/diagnostics/sec002-av-fixture/validate.mjs') source $repo $SourceHead
 if($LASTEXITCODE -ne 0){throw 'source_entry'};$state.sourceValidAtEntry=$true
 & node (Join-Path $repo 'scripts/diagnostics/sec002-av-fixture/validate.mjs') extract (Join-Path $incoming 'archive.zip') (Join-Path $incoming 'verified')
 if($LASTEXITCODE -ne 0){throw 'artifact_identity'};$state.artifactVerified=$true
 $runtime=Get-Content -LiteralPath (Join-Path $incoming 'runtime-private.json') -Raw | ConvertFrom-Json
 $actual=& node -p 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,execPath:process.execPath})'
 if($LASTEXITCODE -ne 0){throw 'node_identity'};$actual=$actual | ConvertFrom-Json
 if($actual.version -cne 'v24.20.0' -or $actual.arch -cne 'x64' -or $actual.platform -cne 'win32' -or $actual.execPath -cne $runtime.execPath -or (Get-FileHash -LiteralPath $runtime.execPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $runtime.sha256){throw 'node_identity'}
 $node=$runtime.execPath;$state.targetNodeSha256=$runtime.sha256;$state.targetNodeIdentityVerified=$true
 $script=(Resolve-Path (Join-Path $PSScriptRoot 'fixture.mjs')).Path;$state.scriptSha256=(Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash.ToLowerInvariant();Save
 try {Add-Type -Path @((Join-Path $repo 'scripts/diagnostics/sec002-av-fixture/NativeController.cs'),(Join-Path $PSScriptRoot 'NodeController.cs')) -ErrorAction Stop}
 catch {
  # Only fixed CS codes/line numbers; never publish diagnostics/source/error text.
  $text=[string]$_.Exception.Message
  foreach($m in [regex]::Matches($text,'\((\d+),\d+\):\s*(?:error|warning)\s+(CS\d{4})')){
   if($state.compileDiagnostics.Count -ge 16){break};$state.compileDiagnostics+=@{code=$m.Groups[2].Value;line=[int]$m.Groups[1].Value}
  }
  throw 'compile_unavailable'
 }
 if(![Sec002Fixture.Controller]::Layouts()){throw 'layout_unavailable'}
 $sentinel=[Sec002Fixture.Sentinel]::new($node,$private);$state.sentinelAlive=$sentinel.Alive();if(!$state.sentinelAlive){throw 'sentinel_lost'}
 foreach($mode in @('handoff','timeout','collector-kill')){
  if(!$sentinel.Alive()){throw 'sentinel_lost'}
  $cwd=Join-Path $private ($mode+' 雪 path');New-Item -ItemType Directory -Path $cwd | Out-Null
  $phases=if($mode -ceq 'handoff'){@('baseline','wrapped')}else{@('wrapped')}
  foreach($phase in $phases){
   $context=[ordered]@{mode=$mode;phase=$phase;cwd=$cwd;node=$node;version='v24.20.0';arch='x64';platform='win32'}
   $context | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cwd 'context.json') -Encoding utf8
   $native=[Sec002Fixture.NodeController]::Run((Join-Path $incoming 'verified/capture.exe'),$node,$runtime.sha256,$script,$mode,$phase,$cwd,(Join-Path $cwd 'capture.json'))
   $nativePath=Join-Path $cwd ($phase+'.native.json');$native | ConvertTo-Json | Set-Content -LiteralPath $nativePath -Encoding utf8
   $output=Join-Path $publish ($mode+'-'+$phase+'.json')
   & node (Join-Path $PSScriptRoot 'validate.mjs') $cwd $nativePath $output
   $exit=$LASTEXITCODE
   if(Test-Path -LiteralPath $output){$safe=Get-Content -LiteralPath $output -Raw | ConvertFrom-Json;$state.cases+=@{mode=$mode;phase=$phase;passed=$safe.passed}}
   else {$state.cases+=@{mode=$mode;phase=$phase;passed=$false;missingOrInvalidObservation=$true;cleanupComplete=$native.CleanupComplete;forced=$native.Forced;fallbackJobKill=$native.FallbackJobKill}}
   $state.sentinelAlive=$sentinel.Alive();Save
   if($exit -ne 0 -or !$state.sentinelAlive){throw 'case_failed_stop'}
  }
  if($mode -ceq 'handoff'){$state.handoffAdmitted=$true;Save}
 }
 if(!$state.handoffAdmitted -or $state.cases.Count -ne 4 -or @($state.cases | Where-Object {!$_.passed}).Count -ne 0){throw 'incomplete_cases'}
 $state.status='node_core_passed'
} catch {
 $allowed=@('workflow_entry','fresh_directory_required','source_entry','artifact_identity','node_identity','compile_unavailable','layout_unavailable','sentinel_lost','case_failed_stop','incomplete_cases')
 $message=$_.Exception.Message;$state.failureCode=if($message -cin $allowed){$message}else{'controller_or_policy_unavailable'};$state.status='failed_or_unavailable'
} finally {
 if($sentinel){try{$state.sentinelAlive=$sentinel.Alive();$state.sentinelCleanupComplete=$sentinel.Stop()}catch{$state.sentinelCleanupComplete=$false}finally{$sentinel.Dispose()}}
 try{& node (Join-Path $repo 'scripts/diagnostics/sec002-av-fixture/validate.mjs') source $repo $SourceHead;$state.sourceValidAtEnd=$LASTEXITCODE -eq 0}catch{$state.sourceValidAtEnd=$false}
 if(!$state.sourceValidAtEnd -or !$state.sentinelCleanupComplete){$state.status='failed_or_unavailable'};Save
}
Write-Output "node-fixture status=$($state.status) comparisons=$($state.cases.Count) productExecuted=false stackImplemented=false"
if($state.status -cne 'node_core_passed'){exit 1}
