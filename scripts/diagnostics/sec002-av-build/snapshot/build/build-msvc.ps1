# Recipe only; run later in a separately authorized x64 Native Tools environment.
# No install/download/vswhere/registry discovery. Explicit compiler/SDK/version inputs.
param(
  [Parameter(Mandatory=$true)][string]$Compiler,
  [Parameter(Mandatory=$true)][string]$CompilerSha256,
  [Parameter(Mandatory=$true)][string]$SdkInclude,
  [Parameter(Mandatory=$true)][string]$SdkLib,
  [Parameter(Mandatory=$true)][string]$VcInclude,
  [Parameter(Mandatory=$true)][string]$VcLib,
  [Parameter(Mandatory=$true)][string]$Linker,
  [Parameter(Mandatory=$true)][string]$LinkerSha256,
  [Parameter(Mandatory=$true)][string]$Dumpbin,
  [Parameter(Mandatory=$true)][string]$DumpbinSha256,
  [Parameter(Mandatory=$true)][string]$ToolsetVersion,
  [Parameter(Mandatory=$true)][string]$DependencyManifest,
  [Parameter(Mandatory=$true)][string]$DependencyManifestSha256
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
foreach($file in @(@($Compiler,$CompilerSha256),@($Linker,$LinkerSha256),@($Dumpbin,$DumpbinSha256))){
  if(!(Test-Path -LiteralPath $file[0] -PathType Leaf) -or (Get-FileHash -LiteralPath $file[0] -Algorithm SHA256).Hash -ne $file[1]){throw 'unavailable_tool_identity'}
}
if($ToolsetVersion -notmatch '^14\.44\.[0-9]+$'){throw 'unavailable_toolset_version'}
if((Get-FileHash -LiteralPath $DependencyManifest -Algorithm SHA256).Hash -ne $DependencyManifestSha256){throw 'dependency_manifest_identity'}
$manifest=Get-Content -LiteralPath $DependencyManifest -Raw | ConvertFrom-Json
$roots=@{sdkInclude=$SdkInclude; sdkLib=$SdkLib; vcInclude=$VcInclude; vcLib=$VcLib}
foreach($name in $roots.Keys){
  $expected=@($manifest.$name | Sort-Object relativePath)
  if($expected.Count -eq 0){throw 'empty_dependency_manifest'}
  $base=(Resolve-Path -LiteralPath $roots[$name]).Path
  $actual=@(Get-ChildItem -LiteralPath $base -Recurse -File | ForEach-Object {
    [pscustomobject]@{relativePath=$_.FullName.Substring($base.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  } | Sort-Object relativePath)
  if(($actual | ConvertTo-Json -Compress -Depth 5) -cne ($expected | ConvertTo-Json -Compress -Depth 5)){throw 'dependency_content_mismatch'}
}
# Inputs must point at the selected Windows SDK 10.0.26100.0 and an x64 MSVC toolset.
# The exact compiler/linker hashes above are required; never silently choose an installed version.
if((Split-Path $SdkInclude -Leaf) -ne '10.0.26100.0' -or (Split-Path $SdkLib -Leaf) -ne '10.0.26100.0'){throw 'unavailable_sdk_version'}
$out=Join-Path $PSScriptRoot 'out'
if(Test-Path -LiteralPath $out){throw 'output_exists'}
New-Item -ItemType Directory -Path $out | Out-Null
# Warnings are recorded and fail the build (/WX). Do not silently relax to produce a binary.
$common=@('/nologo','/std:c++17','/W4','/WX','/EHsc','/O2','/MT','/Brepro','/DUNICODE','/D_UNICODE',"/I$VcInclude","/I$SdkInclude\ucrt","/I$SdkInclude\shared","/I$SdkInclude\um")
$links=@('/MACHINE:X64','/INCREMENTAL:NO','/Brepro',"/LIBPATH:$VcLib","/LIBPATH:$SdkLib\ucrt\x64","/LIBPATH:$SdkLib\um\x64",'kernel32.lib','/NODEFAULTLIB:MSVCRT')
# Compile and link are separate; the hash-checked linker is invoked by absolute path.
# CL/LINK ambient switches are rejected; never claim byte reproduction from this recipe alone.
if($env:CL -or $env:_CL_ -or $env:LINK -or $env:_LINK_){throw 'ambient_compiler_override'}
Push-Location $out
try {
  Copy-Item -LiteralPath $DependencyManifest -Destination 'dependency-manifest.json'
  [ordered]@{toolsetVersion=$ToolsetVersion;compilerSha256=$CompilerSha256;linkerSha256=$LinkerSha256;dumpbinSha256=$DumpbinSha256;dependencyManifestSha256=$DependencyManifestSha256;sdkVersion='10.0.26100.0';sourceHead=(& git -C $root rev-parse HEAD)} | ConvertTo-Json | Set-Content 'provenance.json'
  & $Compiler @common '/c' (Join-Path $root 'src\capture.cpp') '/Fo:capture.obj' 2>&1 | Tee-Object 'capture-build.log'
  if($LASTEXITCODE -ne 0){throw 'capture_compile_failed'}
  & $Linker '/nologo' '/OUT:capture.exe' 'capture.obj' @links 2>&1 | Tee-Object 'capture-link.log'
  if($LASTEXITCODE -ne 0){throw 'capture_link_failed'}
  & $Compiler @common '/c' (Join-Path $root 'fixtures\fault-fixture.cpp') '/Fo:fault-fixture.obj' 2>&1 | Tee-Object 'fixture-build.log'
  if($LASTEXITCODE -ne 0){throw 'fixture_compile_failed'}
  & $Linker '/nologo' '/OUT:fault-fixture.exe' 'fault-fixture.obj' @links 2>&1 | Tee-Object 'fixture-link.log'
  if($LASTEXITCODE -ne 0){throw 'fixture_link_failed'}
  foreach($binary in @('capture.exe','fault-fixture.exe')){
    & $Dumpbin /headers /imports $binary | Set-Content "$binary.pe.txt"
    if($LASTEXITCODE -ne 0){throw 'pe_inspection_failed'}
    Get-FileHash $binary -Algorithm SHA256 | ConvertTo-Json | Set-Content "$binary.sha256.json"
  }
  # Static inspection must independently verify AMD64, subsystem console, imports,
  # capture.exe: only KERNEL32.dll imports; no DbgHelp/SymSrv/WinHTTP/WinINet/Winsock.
  # /MT may produce toolchain-specific imports; any extra DLL is a review failure, never auto-allowed.
  # fixture.exe: only KERNEL32.dll imports under this pinned /MT recipe.
  # signature/policy constraints and absence of unintended symbol/network libraries.
  # This recipe NEVER launches either EXE.
} finally { Pop-Location }
