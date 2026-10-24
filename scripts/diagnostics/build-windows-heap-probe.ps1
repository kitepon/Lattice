param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
$version = (& node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne '24.20.0') { throw "Probe requires the original Node 24.20.0, got $version" }
$inputs = @(
  @{ Name='node-v24.20.0-headers.tar.gz'; Url='https://nodejs.org/download/release/v24.20.0/node-v24.20.0-headers.tar.gz'; Hash='7b2141e77e66ab23ead6b200c546afc5837136e3075d8a3ac5a67e540dcc59c1' },
  @{ Name='node.lib'; Url='https://nodejs.org/download/release/v24.20.0/win-x64/node.lib'; Hash='63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9' }
)
foreach ($inputFile in $inputs) {
  $target = Join-Path $output $inputFile.Name
  Invoke-WebRequest -Uri $inputFile.Url -OutFile $target
  if ((Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant() -ne $inputFile.Hash) { throw "Node probe input hash mismatch: $($inputFile.Name)" }
}
& tar -xzf (Join-Path $output 'node-v24.20.0-headers.tar.gz') -C $output
if ($LASTEXITCODE -ne 0) { throw 'Node headers extraction failed' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Installed MSVC discovery tool vswhere is missing' }
$installation = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $installation) { throw 'An installed MSVC x64 toolchain was not found' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'windows-heap-probe.cc'))
$include = Join-Path $output 'node-v24.20.0/include/node'
$addon = Join-Path $output 'heap-probe.node'
$object = Join-Path $output 'heap-probe.obj'
$library = Join-Path $output 'node.lib'
$pdb = Join-Path $output 'heap-probe.pdb'
$build = Join-Path $output 'build-probe.cmd'
@("@echo off", "call `"$vcvars`"", 'if errorlevel 1 exit /b %errorlevel%',
  "cl.exe /nologo /LD /MT /EHsc /Z7 /std:c++17 /DNODE_GYP_MODULE_NAME=heap_probe /DBUILDING_NODE_EXTENSION /DNAPI_VERSION=8 /I`"$include`" `"$source`" /Fo`"$object`" /link /DEBUG /PDB:`"$pdb`" /OUT:`"$addon`" `"$library`" kernel32.lib", 'exit /b %errorlevel%') |
  Set-Content -Encoding ascii $build
& cmd.exe /d /c $build
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $addon)) { throw 'Native heap probe build failed' }
& node -e 'const p=require(process.argv[1]);for(let i=0;i<10;i++)if(p.check(i)!==true)process.exit(2);console.log("heap probe load/default heap check passed")' $addon
if ($LASTEXITCODE -ne 0) { throw 'Native heap probe load/default heap smoke failed' }
@{ Node=$version; Inputs=$inputs; SourceHash=(Get-FileHash -Algorithm SHA256 $source).Hash.ToLowerInvariant(); AddonHash=(Get-FileHash -Algorithm SHA256 $addon).Hash.ToLowerInvariant(); CompilerInstallation=$installation; Smoke='passed' } |
  ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $output 'build.json')
