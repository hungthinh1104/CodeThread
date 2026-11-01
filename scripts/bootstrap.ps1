param()
$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$toolingRoot = Join-Path $workspaceRoot '.tooling'
$nodeVersion = '24.22.2'
$pnpmVersion = '12.16.1'
$archiveHash = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This optional bootstrap supports Windows x64; use the documented system toolchain on other platforms.' }
New-Item -ItemType Directory -Path $toolingRoot -Force | Out-Null
$archivePath = Join-Path $toolingRoot "node-v$nodeVersion-win-x64.zip"
if (-not (Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile ($archivePath + '.part') -TimeoutSec 180
  Move-Item -LiteralPath ($archivePath + '.part') -Destination $archivePath
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) { throw 'Node archive checksum mismatch; no downloaded code was executed.' }
$nodeDirectory = Join-Path $toolingRoot "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe'))) { Expand-Archive -LiteralPath $archivePath -DestinationPath $toolingRoot }
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
if ((& $nodeExecutable --version) -ne "v$nodeVersion") { throw 'Unexpected Node version' }
$env:PATH = $nodeDirectory + ';' + $env:PATH
$npmEntry = Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js'
$managerDirectory = Join-Path $toolingRoot 'package-manager'
& $nodeExecutable $npmEntry install --prefix $managerDirectory --no-save --package-lock=false --ignore-scripts "pnpm@$pnpmVersion"
if ($LASTEXITCODE -ne 0) { throw 'Pinned pnpm installation failed' }
$pnpmExecutable = Join-Path $managerDirectory 'node_modules/@pnpm/exe.win32-x64/pnpm.exe'
if ((& $pnpmExecutable --version) -ne $pnpmVersion) { throw 'Unexpected pnpm version' }
Write-Output 'Local tools are ready. Use scripts/pnpm.ps1 to run commands; system settings were not changed.'
