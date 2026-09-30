# Pack Windows installer (Bridge exe + Electron)
#
# Prereqs: Node 20+, pnpm 9+, uv, Windows x64
#
# Usage (repo root):
#   pnpm dist
#
# Output:
#   apps/desktop/release/米家-0.1.0-Setup.exe
#   apps/bridge/dist/mi-home-bridge/mi-home-bridge.exe

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "==> Building Bridge (PyInstaller)..." -ForegroundColor Cyan
pnpm bridge:build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bridgeExe = "apps/bridge/dist/mi-home-bridge/mi-home-bridge.exe"
if (-not (Test-Path $bridgeExe)) {
  Write-Error "Bridge exe missing: $bridgeExe"
  exit 1
}

Write-Host "==> Building desktop + NSIS installer..." -ForegroundColor Cyan
pnpm --filter @mi-home/desktop dist
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Done. Installer under apps/desktop/release/" -ForegroundColor Green
Get-ChildItem "apps/desktop/release" -Filter "*.exe" | ForEach-Object { Write-Host $_.FullName }
