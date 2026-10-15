# Build-only caller. Never invokes capture.exe, fault-fixture.exe or Lattice product code.
param([Parameter(Mandatory=$true)][string]$ExpectedSourceHead,[Parameter(Mandatory=$true)][string]$ExpectedWorkflowHead,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$snapshot=Join-Path $PSScriptRoot 'snapshot'
$manifestHash='28b7766841e3c8ddae60008432508a2780aee0e4b22042de9bf062e5b80ef813'
$localSourceHead='4ab846c70883170f94b6af05b99cb049e2cff0f4'
if($ExpectedSourceHead -cnotmatch '^[0-9a-f]{40}$' -or $ExpectedWorkflowHead -cnotmatch '^[0-9a-f]{40}$'){throw 'invalid_pinned_sha'}
if(![IO.Path]::IsPathFullyQualified($Output) -or (Test-Path -LiteralPath $Output)){throw 'output_must_be_new_absolute_path'}
New-Item -ItemType Directory -Path $Output | Out-Null
$state=[ordered]@{schema='sec002-hosted-av-build-v1';phase='entry';sourceHead=$ExpectedSourceHead;workflowHead=$ExpectedWorkflowHead;localSourceHead=$localSourceHead;manifestSha256=$manifestHash;imageOS=$env:ImageOS;imageVersion=$env:ImageVersion;runId=$env:GITHUB_RUN_ID;attempt=$env:GITHUB_RUN_ATTEMPT;runnerName=$env:RUNNER_NAME;runnerOS=$env:RUNNER_OS;runnerArch=$env:RUNNER_ARCH;sourceValidAtEntry=$false;sourceValidAtEnd=$false;executedTargetBinaries=0;windowsFixtureExecuted=$false;productExecuted=$false;stackImplemented=$false;status='incomplete';failureStage=$null;failureCode=$null;phaseTimesUtc=[ordered]@{};updatedUtc=$null}
function Save-State { $state.updatedUtc=[DateTime]::UtcNow.ToString('o');if(!$state.phaseTimesUtc.Contains($state.phase)){$state.phaseTimesUtc[$state.phase]=$state.updatedUtc};$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Output 'summary.json') -Encoding utf8 }
function Assert-Source {
  $head=& git -C $root rev-parse HEAD
  if($LASTEXITCODE -ne 0 -or $head -cne $ExpectedSourceHead){throw 'source_sha_mismatch'}
  $dirty=& git -C $root status --porcelain --untracked-files=no
  if($LASTEXITCODE -ne 0 -or $dirty){throw 'tracked_source_dirty'}
  $path=Join-Path $PSScriptRoot 'source-manifest.json'
  if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifestHash){throw 'snapshot_manifest_mismatch'}
  $manifest=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if($manifest.sourceHead -cne $localSourceHead -or !$manifest.trackedClean -or @($manifest.files).Count -ne 13){throw 'snapshot_manifest_identity'}
  $buildOutput=[IO.Path]::GetFullPath((Join-Path $snapshot 'build/out'))
  $actual=@(Get-ChildItem -LiteralPath $snapshot -Recurse -File -Force | Where-Object { !$_.FullName.StartsWith($buildOutput+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.FullName.Substring($snapshot.Length+1).Replace('\','/') } | Sort-Object)
  $expected=@($manifest.files.path | Sort-Object)
  if(($actual -join "`n") -cne ($expected -join "`n")){throw 'snapshot_path_inventory'}
  foreach($row in $manifest.files){
    if($row.path -match '(^/|(^|/)\.\.(/|$)|:)'){throw 'snapshot_invalid_path'}
    $file=Join-Path $snapshot $row.path
    if((Get-Item -LiteralPath $file).Length -ne $row.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256){throw 'snapshot_file_mismatch'}
  }
}
function Write-Manifest([string]$Base) {
  if(!(Test-Path -LiteralPath $Base -PathType Container)){throw 'required_toolchain_directory_missing'}
  $resolved=(Resolve-Path -LiteralPath $Base).Path
  return @(Get-ChildItem -LiteralPath $resolved -Recurse -File | Sort-Object FullName | ForEach-Object {
    if($_.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'toolchain_reparse_point'}
    [ordered]@{relativePath=$_.FullName.Substring($resolved.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  } | Sort-Object relativePath)
}
function Inspect-PE([string]$Path) {
  $file=Get-Item -LiteralPath $Path
  if($file.Length -gt 33554432 -or $file.Length -lt 256){throw 'pe_size_invalid'}
  $bytes=[IO.File]::ReadAllBytes($Path)
  $u16={param([long]$i) if($i -lt 0 -or $i+2 -gt $bytes.Length){throw 'pe_bounds'};[BitConverter]::ToUInt16($bytes,$i)}
  $u32={param([long]$i) if($i -lt 0 -or $i+4 -gt $bytes.Length){throw 'pe_bounds'};[BitConverter]::ToUInt32($bytes,$i)}
  if((& $u16 0) -ne 0x5a4d){throw 'pe_dos_signature'}
  $pe=[long](& $u32 0x3c)
  if((& $u32 $pe) -ne 0x4550 -or (& $u16 ($pe+4)) -ne 0x8664){throw 'pe_not_amd64'}
  $count=& $u16 ($pe+6);$optional=$pe+24;$optionalSize=& $u16 ($pe+20)
  if($count -eq 0 -or $count -gt 96 -or $optionalSize -lt 240 -or (& $u16 $optional) -ne 0x20b -or (& $u16 ($optional+68)) -ne 3){throw 'pe_header_or_subsystem'}
  $sections=@()
  for($i=0;$i -lt $count;$i++){$at=$optional+$optionalSize+40*$i;$sections+=@{rva=[long](& $u32 ($at+12));rawSize=[long](& $u32 ($at+16));raw=[long](& $u32 ($at+20))}}
  $rvaToOffset={param([long]$rva,[long]$size)
    foreach($section in $sections){$delta=$rva-$section.rva;if($delta -ge 0 -and $size -le $section.rawSize-$delta -and $section.raw+$delta+$size -le $bytes.Length){return ($section.raw+$delta)}}
    throw 'pe_rva_unmapped'
  }
  $importRva=& $u32 ($optional+120);$importSize=& $u32 ($optional+124)
  if(!$importRva -or $importSize -lt 20 -or $importSize -gt 65536){throw 'pe_import_directory'}
  $imports=@();$terminated=$false
  for($i=0;$i -lt [Math]::Min([Math]::Floor($importSize/20),256);$i++){
    $at=& $rvaToOffset ($importRva+20*$i) 20
    $nameRva=& $u32 ($at+12)
    if(!$nameRva){$terminated=$true;break}
    $nameBytes=[Collections.Generic.List[byte]]::new()
    for($j=0;$j -lt 128;$j++){$offset=& $rvaToOffset ($nameRva+$j) 1;$value=$bytes[$offset];if(!$value){break};$nameBytes.Add($value)}
    if($nameBytes.Count -eq 128){throw 'pe_import_name_too_long'}
    $name=[Text.Encoding]::ASCII.GetString($nameBytes.ToArray()).ToLowerInvariant()
    if($name -cnotmatch '^[a-z0-9._-]{1,127}$'){throw 'pe_import_name_invalid'}
    $imports+= $name
  }
  if(!$terminated -or !$imports.Count){throw 'pe_imports_incomplete'}
  $result=[ordered]@{machine='AMD64';optionalHeader='PE32+';subsystem='console';imports=@($imports | Sort-Object -Unique);bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant();executed=$false}
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Output ($file.Name+'.inspection.json')) -Encoding utf8
  if(@($imports | Where-Object { $_ -cne 'kernel32.dll' }).Count -ne 0){throw 'unexpected_pe_import'}
  return $result
}
Save-State
try {
  if($env:GITHUB_SHA -cne $ExpectedWorkflowHead -or $env:GITHUB_REF -cne 'refs/heads/snowwhite/sec002-hosted-av-build' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch'){throw 'workflow_entry_mismatch'}
  if($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or $env:ImageOS -cne 'win25' -or !$env:ImageVersion){throw 'hosted_windows2025_required'}
  Assert-Source;$state.sourceValidAtEntry=$true
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'source-manifest.json') -Destination (Join-Path $Output 'source-manifest.json')
  $state.phase='toolchain';Save-State
  $vs='C:\Program Files\Microsoft Visual Studio\2022\Enterprise'
  $toolsets=@(Get-ChildItem -LiteralPath (Join-Path $vs 'VC\Tools\MSVC') -Directory | Where-Object { $_.Name -cmatch '^14\.44\.[0-9]+$' })
  if($toolsets.Count -ne 1){throw 'required_14_44_toolset_not_unique_or_missing'}
  $toolset=$toolsets[0].FullName;$bin=Join-Path $toolset 'bin\Hostx64\x64'
  $sdk='C:\Program Files (x86)\Windows Kits\10'
  $roots=[ordered]@{sdkInclude=(Join-Path $sdk 'Include\10.0.26100.0');sdkLib=(Join-Path $sdk 'Lib\10.0.26100.0');vcInclude=(Join-Path $toolset 'include');vcLib=(Join-Path $toolset 'lib\x64');vcBin=$bin}
  $dependency=[ordered]@{}
  foreach($key in $roots.Keys){$dependency[$key]=@(Write-Manifest $roots[$key])}
  $depFile=Join-Path $Output 'dependency-manifest.json'
  $dependency | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $depFile -Encoding utf8
  $tools=[ordered]@{}
  foreach($name in @('cl.exe','link.exe','dumpbin.exe')){
    $path=Join-Path $bin $name
    $item=Get-Item -LiteralPath $path
    $tools[$name]=[ordered]@{path=$item.FullName;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();fileVersion=$item.VersionInfo.FileVersion;productVersion=$item.VersionInfo.ProductVersion}
  }
  [ordered]@{vsRoot=$vs;toolsetVersion=$toolsets[0].Name;sdkVersion='10.0.26100.0';roots=$roots;tools=$tools;dependencyManifestSha256=(Get-FileHash -LiteralPath $depFile -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $Output 'toolchain.json') -Encoding utf8
  # Clear process-local implicit include/library switches only. No machine setting is changed.
  foreach($name in @('CL','_CL_','LINK','_LINK_')){if([Environment]::GetEnvironmentVariable($name)){throw 'ambient_build_switch_override'}}
  $env:INCLUDE='';$env:LIB='';$env:LIBPATH=''
  $state.phase='compile-link';Save-State
  $recipe=Join-Path $snapshot 'build/build-msvc.ps1'
  try {
    & $recipe -Compiler $tools['cl.exe'].path -CompilerSha256 $tools['cl.exe'].sha256 -Linker $tools['link.exe'].path -LinkerSha256 $tools['link.exe'].sha256 -Dumpbin $tools['dumpbin.exe'].path -DumpbinSha256 $tools['dumpbin.exe'].sha256 -SdkInclude $roots.sdkInclude -SdkLib $roots.sdkLib -VcInclude $roots.vcInclude -VcLib $roots.vcLib -ToolsetVersion $toolsets[0].Name -DependencyManifest $depFile -DependencyManifestSha256 ((Get-FileHash -LiteralPath $depFile -Algorithm SHA256).Hash.ToLowerInvariant())
  } finally {
    $buildOut=Join-Path $snapshot 'build/out'
    if(Test-Path -LiteralPath $buildOut){
      Get-ChildItem -LiteralPath $buildOut -File | Where-Object { $_.Extension -in @('.log','.json','.txt','.exe') } | Copy-Item -Destination $Output
    }
  }
  $state.phase='pe-inspection';Save-State
  $inspectionFailure=$null
  foreach($name in @('capture.exe','fault-fixture.exe')){
    try { Inspect-PE (Join-Path $Output $name) | Out-Null } catch { if(!$inspectionFailure){$inspectionFailure=$_.Exception.Message} }
  }
  if($inspectionFailure){throw $inspectionFailure}
  $state.status='build_only_success';$state.phase='finished'
} catch {
  $state.status='failed';$state.failureStage=$state.phase
  # ErrorRecord is not printed; only a fixed code plus compiler's own build log is retained.
  $allowed=@('invalid_pinned_sha','source_sha_mismatch','tracked_source_dirty','snapshot_manifest_mismatch','snapshot_manifest_identity','snapshot_path_inventory','snapshot_invalid_path','snapshot_file_mismatch','workflow_entry_mismatch','hosted_windows2025_required','required_14_44_toolset_not_unique_or_missing','required_toolchain_directory_missing','toolchain_reparse_point','ambient_build_switch_override','unavailable_tool_identity','unavailable_toolset_version','dependency_manifest_identity','empty_dependency_manifest','dependency_content_mismatch','unavailable_sdk_version','output_exists','capture_compile_failed','capture_link_failed','fixture_compile_failed','fixture_link_failed','pe_inspection_failed','pe_size_invalid','pe_bounds','pe_dos_signature','pe_not_amd64','pe_header_or_subsystem','pe_rva_unmapped','pe_import_directory','pe_import_name_too_long','pe_import_name_invalid','pe_imports_incomplete','unexpected_pe_import')
  $code=$_.Exception.Message;$state.failureCode=if($code -cin $allowed){$code}else{'build_observer_error'}
} finally {
  try { Assert-Source;$state.sourceValidAtEnd=$true } catch { $state.sourceValidAtEnd=$false;$state.status='failed';if(!$state.failureCode){$state.failureCode='source_exit_invalid'} }
  Save-State
}
if($state.status -cne 'build_only_success'){Write-Output "build-only failed stage=$($state.failureStage) code=$($state.failureCode)";exit 1}
Write-Output 'build-only success; executedTargetBinaries=0; metadata-only; Windows runtime unvalidated'
