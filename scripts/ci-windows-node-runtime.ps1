param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$runtimeDirectory = [IO.Path]::GetFullPath($Directory)
New-Item -ItemType Directory -Force $runtimeDirectory | Out-Null
$exe = Join-Path $runtimeDirectory 'node.exe'
$expected = 'ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c'
if (-not (Test-Path $exe)) {
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.22.0/win-x64/node.exe' -OutFile $exe -TimeoutSec 180
}
if ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLowerInvariant() -ne $expected) { throw 'Product CI Node checksum mismatch' }
$actual = (& $exe -p 'JSON.stringify({node:process.versions.node,execPath:process.execPath})') | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $actual.node -ne '24.22.0') { throw 'Product CI did not execute the pinned repaired Node' }
# Windows' installed npm launcher may bind to its adjacent host node.exe.
# Keep npm itself and all npm-script children on this job's repaired runtime.
$npmLauncher = (Get-Command npm -ErrorAction Stop).Source
$npmCli = Join-Path (Split-Path -Parent $npmLauncher) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Installed npm CLI could not be located safely' }
$quotedNpmCli = $npmCli.Replace("'", "''")
"& (Join-Path `$PSScriptRoot 'node.exe') '$quotedNpmCli' @args`nexit `$LASTEXITCODE" | Set-Content -Encoding utf8 (Join-Path $runtimeDirectory 'npm.ps1')
$batchNpmCli = $npmCli.Replace('%', '%%')
"@echo off`r`n`"%~dp0node.exe`" `"$batchNpmCli`" %*`r`nexit /b %errorlevel%" | Set-Content -Encoding utf8 (Join-Path $runtimeDirectory 'npm.cmd')
Write-Output (ConvertTo-Json -Compress @{ Node=$actual.node; Executable=$actual.execPath; Sha256=$expected; Scope='owned product CI job' })
if (-not $env:GITHUB_OUTPUT) { throw 'Product CI step output is unavailable' }
"directory=$runtimeDirectory" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
