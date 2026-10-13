<#
.SYNOPSIS
  Installs Sentinel as a Windows service with NSSM, plus a nightly maintenance task.

.DESCRIPTION
  Layout (override with -Root):
    C:\sentinel\app      code: dist\, node_modules\ (production), package.json  (git checkout of this repo)
    C:\sentinel\config   YAML config (config\wallets.yaml is local only)
    C:\sentinel\.env     secrets, never in git
    C:\sentinel\data     SQLite database (WAL)
    C:\sentinel\backups  nightly DB backups
    C:\sentinel\logs     service stdout/stderr, rotated by NSSM

  The service runs `node dist\cli.js run --config C:\sentinel\config` with C:\sentinel as its working
  directory, so `.env`, `./data` and `./backups` resolve exactly as they do in the Docker image.
  Keep this file, the Dockerfile and compose.yaml in sync (test/deploy-sync.test.ts checks the shared parts).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-service.ps1
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\sentinel',
  [string]$ServiceName = 'sentinel',
  [string]$NodePath = '',
  [string]$NssmPath = '',
  [string]$ServiceUser = '',       # default LocalSystem; pass DOMAIN\user and you will be prompted for the password
  [string]$MaintenanceTime = '03:30',
  [switch]$SkipConfigCheck
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated (Administrator) PowerShell.'
  }
}

function Resolve-Tool([string]$Explicit, [string]$Name, [string]$Hint) {
  if ($Explicit) { if (Test-Path $Explicit) { return (Resolve-Path $Explicit).Path } else { throw "$Name not found at $Explicit" } }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "$Name not found on PATH. $Hint" }
  return $cmd.Source
}

Assert-Admin
$node = Resolve-Tool $NodePath 'node.exe' 'Install Node 22 LTS system-wide: winget install OpenJS.NodeJS.LTS'
$nssm = Resolve-Tool $NssmPath 'nssm.exe' 'Install NSSM: winget install NSSM.NSSM (or choco install nssm)'

$major = [int](& $node -p 'process.versions.node.split(".")[0]')
if ($major -lt 22) { throw "Node $major found; Sentinel needs Node 22 or newer ($node)." }

$app = Join-Path $Root 'app'
$cli = Join-Path $app 'dist\cli.js'
$config = Join-Path $Root 'config'
foreach ($d in @($Root, $config, (Join-Path $Root 'data'), (Join-Path $Root 'backups'), (Join-Path $Root 'logs'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
if (-not (Test-Path $cli)) { throw "$cli not found. Clone the repo to $app, then: npm ci; npm run build; npm prune --omit=dev" }
if (-not (Test-Path (Join-Path $Root '.env'))) { throw "$Root\.env not found. Copy .env.example there and fill it in." }
if (-not (Test-Path (Join-Path $config 'sentinel.yaml'))) { throw "No config in $config. Copy the repo's config\ folder there (and create wallets.yaml from wallets.example.yaml)." }

if (-not $SkipConfigCheck) {
  Push-Location $Root
  try {
    & $node $cli config check --config $config
    if ($LASTEXITCODE -ne 0) { throw 'sentinel config check failed. Fix the config (the service refuses to start on an invalid config).' }
  } finally { Pop-Location }
}

# --- service -------------------------------------------------------------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Service $ServiceName exists: stopping and reconfiguring."
  & $nssm stop $ServiceName confirm | Out-Null
} else {
  & $nssm install $ServiceName $node $cli run --config $config
  if ($LASTEXITCODE -ne 0) { throw 'nssm install failed' }
}

& $nssm set $ServiceName Application $node | Out-Null
& $nssm set $ServiceName AppParameters "`"$cli`" run --config `"$config`"" | Out-Null
& $nssm set $ServiceName AppDirectory $Root | Out-Null
& $nssm set $ServiceName DisplayName 'Sentinel on-chain holdings monitor' | Out-Null
& $nssm set $ServiceName Description 'Watches on-chain holdings and alerts via Telegram. https://github.com/bfcapll/sentinel' | Out-Null
& $nssm set $ServiceName Start SERVICE_DELAYED_AUTO_START | Out-Null   # after the network is up; runs before any user logs in
if ($ServiceUser) {
  $secure = Read-Host -AsSecureString "Password for $ServiceUser"
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  & $nssm set $ServiceName ObjectName $ServiceUser $plain | Out-Null
} else {
  & $nssm set $ServiceName ObjectName LocalSystem | Out-Null
}
& $nssm set $ServiceName AppEnvironmentExtra 'NODE_ENV=production' | Out-Null

# Logs: pino writes JSON lines to stdout; NSSM captures and rotates (10 MB or daily, online rotation).
& $nssm set $ServiceName AppStdout (Join-Path $Root 'logs\sentinel.out.log') | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $Root 'logs\sentinel.err.log') | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateOnline 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $nssm set $ServiceName AppRotateSeconds 86400 | Out-Null

# Restart on any exit (crash, invalid config after an edit, Windows Update reboot), with a delay so a
# config error does not spin. Ctrl+C first so the service closes SQLite cleanly.
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 10000 | Out-Null
& $nssm set $ServiceName AppThrottle 5000 | Out-Null
& $nssm set $ServiceName AppStopMethodConsole 15000 | Out-Null
& $nssm set $ServiceName AppStopMethodWindow 0 | Out-Null
& $nssm set $ServiceName AppStopMethodThreads 0 | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null

# --- nightly maintenance: DB backup + log retention ------------------------------------------------
$maint = Join-Path $app 'deploy\windows\maintenance.ps1'
$taskName = "$ServiceName-maintenance"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$maint`" -Root `"$Root`" -Node `"$node`""
$trigger = New-ScheduledTaskTrigger -Daily -At $MaintenanceTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# --- go ---------------------------------------------------------------------------------------------
& $nssm start $ServiceName | Out-Null
Start-Sleep -Seconds 5
Get-Service $ServiceName | Format-Table Name, Status, StartType -AutoSize
Write-Host "Installed. Logs: $Root\logs. Maintenance task '$taskName' runs daily at $MaintenanceTime."
Write-Host "Next: send /status to your P1 bot, then run the Phase 0 exit-criteria runbook in README.md."
