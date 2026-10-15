# Preparation-only fixture caller. Windows execution requires Dorothy's separate permission.
param([Parameter(Mandatory=$true)][string]$SourceHead,[Parameter(Mandatory=$true)][string]$WorkflowHead,[Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$publish=Join-Path $Root 'publish';$incoming=Join-Path $Root 'incoming';$private=Join-Path $Root 'quarantine'
$state=[ordered]@{schema='sec002-fixture-controller-v1';sourceHead=$SourceHead;workflowHead=$WorkflowHead;status='incomplete';sourceValidAtEntry=$false;sourceValidAtEnd=$false;artifactVerified=$false;normalAdmitted=$false;sentinelAlive=$false;sentinelCleanupComplete=$false;fixtureCoreComplete=$false;stackImplemented=$false;productExecuted=$false;additionalFixture9b763Compiled=$false;receivedArgvCwdEnvVerified=$false;launchContextUnchangedByController=$true;modes=@();failureCode=$null}
$sentinel=$null
function Save { $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $publish 'controller-summary.json') -Encoding utf8 }
try {
  if($env:GITHUB_SHA -cne $WorkflowHead -or $env:GITHUB_WORKFLOW_SHA -cne $WorkflowHead -or $env:GITHUB_REF -cne 'refs/heads/snowwhite/sec002-fixture-controller' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch'){throw 'workflow_entry'}
  if(!(Test-Path -LiteralPath $publish -PathType Container) -or (Test-Path -LiteralPath $private)){throw 'fresh_directory_required'}
  New-Item -ItemType Directory -Path $private | Out-Null
  Save
  & node (Join-Path $PSScriptRoot 'validate.mjs') source $repo $SourceHead
  if($LASTEXITCODE -ne 0){throw 'source_entry'}
  $state.sourceValidAtEntry=$true
  & node (Join-Path $PSScriptRoot 'validate.mjs') extract (Join-Path $incoming 'archive.zip') (Join-Path $incoming 'verified')
  if($LASTEXITCODE -ne 0){throw 'artifact_unavailable_or_invalid'}
  $state.artifactVerified=$true;Save
  Add-Type -Path (Join-Path $PSScriptRoot 'NativeController.cs') -ErrorAction Stop
  if(![Sec002Fixture.Controller]::Layouts()){throw 'controller_layout_unavailable'}
  $node=(Get-Command node -CommandType Application).Source
  $sentinel=[Sec002Fixture.Sentinel]::new($node,$private)
  $state.sentinelAlive=$sentinel.Alive();if(!$state.sentinelAlive){throw 'sentinel_start'}
  foreach($mode in @('normal','exit1','exit-av','read','write','execute','handled','thread','breakpoint','child','child-delay')){
    if(!$sentinel.Alive()){throw 'sentinel_lost'}
    $directory=Join-Path $private $mode;New-Item -ItemType Directory -Path $directory | Out-Null
    $rawJson=Join-Path $directory 'capture.json';$nativeJson=Join-Path $directory 'native.json'
    $result=[Sec002Fixture.Controller]::Run((Join-Path $incoming 'verified/capture.exe'),(Join-Path $incoming 'verified/fault-fixture.exe'),$mode,$directory,$rawJson,15000)
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $nativeJson -Encoding utf8
    $judged=Join-Path $publish ($mode+'.json')
    & node (Join-Path $PSScriptRoot 'validate.mjs') judge $rawJson $judged $mode $nativeJson
    $judgeStatus=$LASTEXITCODE
    $state.sentinelAlive=$sentinel.Alive()
    if(Test-Path -LiteralPath $judged){
      $safe=Get-Content -LiteralPath $judged -Raw | ConvertFrom-Json
      $state.modes+= $safe.result
      if($safe.result.stdoutMatched -and $safe.result.stderrMatched){
        [IO.File]::WriteAllBytes((Join-Path $publish ($mode+'.stdout.bin')),[byte[]]$result.Stdout)
        [IO.File]::WriteAllBytes((Join-Path $publish ($mode+'.stderr.bin')),[byte[]]$result.Stderr)
      }
    }else{
      $state.modes+= [ordered]@{mode=$mode;passed=$false;missingOrInvalidObservation=$true;cleanupComplete=$result.CleanupComplete;forced=$result.Forced;timedOut=$result.TimedOut;elapsedMs=$result.ElapsedMs}
    }
    Save
    if($judgeStatus -ne 0 -or !$state.sentinelAlive){throw 'mode_failed_stop'}
    if($mode -ceq 'normal'){$state.normalAdmitted=$true;Save}
  }
  $state.fixtureCoreComplete=$state.normalAdmitted -and $state.modes.Count -eq 11 -and @($state.modes | Where-Object { !$_.passed }).Count -eq 0
  if(!$state.fixtureCoreComplete){throw 'incomplete_modes'}
  $state.status='fixture_core_passed'
} catch {
  $allowed=@('workflow_entry','fresh_directory_required','source_entry','artifact_unavailable_or_invalid','controller_layout_unavailable','sentinel_start','sentinel_lost','mode_failed_stop','incomplete_modes')
  $code=$_.Exception.Message;$state.failureCode=if($code -cin $allowed){$code}else{'controller_or_policy_unavailable'}
  $state.status='failed_or_unavailable'
} finally {
  if($sentinel){try{$state.sentinelAlive=$sentinel.Alive();$state.sentinelCleanupComplete=$sentinel.Stop()}catch{$state.sentinelCleanupComplete=$false}finally{$sentinel.Dispose()}}
  try{& node (Join-Path $PSScriptRoot 'validate.mjs') source $repo $SourceHead;$state.sourceValidAtEnd=$LASTEXITCODE -eq 0}catch{$state.sourceValidAtEnd=$false}
  if(!$state.sourceValidAtEnd -or !$state.sentinelCleanupComplete){$state.status='failed_or_unavailable';$state.fixtureCoreComplete=$false}
  Save
}
Write-Output "fixture-only status=$($state.status) modes=$($state.modes.Count) stackImplemented=false productExecuted=false"
if($state.status -cne 'fixture_core_passed'){exit 1}
