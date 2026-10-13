<#
  Update in place: stop the service, pull, rebuild, validate the config, start.
  The service is left STOPPED if the config check fails (it would refuse to start anyway).
#>
[CmdletBinding()]
param([string]$Root = 'C:\sentinel', [string]$ServiceName = 'sentinel', [string]$Ref = 'origin/main')
$ErrorActionPreference = 'Stop'
$app = Join-Path $Root 'app'
$nssm = (Get-Command nssm.exe).Source
& $nssm stop $ServiceName confirm | Out-Null
Push-Location $app
try {
  git fetch origin
  git checkout --detach $Ref
  npm ci
  npm run build
  npm prune --omit=dev
  Push-Location $Root
  try {
    node (Join-Path $app 'dist\cli.js') config check --config (Join-Path $Root 'config')
    if ($LASTEXITCODE -ne 0) { throw 'config check failed after update; service left stopped' }
  } finally { Pop-Location }
} finally { Pop-Location }
& $nssm start $ServiceName | Out-Null
Get-Service $ServiceName | Format-Table Name, Status -AutoSize
