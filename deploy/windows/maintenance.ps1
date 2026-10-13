<#
  Nightly: consistent SQLite backup (online, WAL-safe) with retention from config store.backup_keep,
  then delete service logs older than -LogDays. Run by the scheduled task install-service.ps1 registers.
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\sentinel',
  [string]$Node = 'node.exe',
  [int]$LogDays = 30
)
$ErrorActionPreference = 'Stop'
$cli = Join-Path $Root 'app\dist\cli.js'
Push-Location $Root
try {
  & $Node $cli backup --config (Join-Path $Root 'config')
  if ($LASTEXITCODE -ne 0) { throw "backup failed with exit code $LASTEXITCODE" }
  Get-ChildItem (Join-Path $Root 'logs') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LogDays) } |
    Remove-Item -Force
} finally { Pop-Location }
