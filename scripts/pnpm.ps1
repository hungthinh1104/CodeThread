$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $workspaceRoot '.tooling/node-v24.22.2-win-x64'
$managerDirectory = Join-Path $workspaceRoot '.tooling/package-manager/node_modules/@pnpm/exe.win32-x64'
$pnpmExecutable = Join-Path $managerDirectory 'pnpm.exe'
if (-not (Test-Path -LiteralPath $pnpmExecutable)) { throw 'Run scripts/bootstrap.ps1 first, or use the pinned system toolchain.' }
$env:PATH = $nodeDirectory + ';' + $managerDirectory + ';' + $env:PATH
Push-Location $workspaceRoot
try {
  & $pnpmExecutable @args
  exit $LASTEXITCODE
} finally { Pop-Location }
