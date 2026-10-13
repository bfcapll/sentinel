[CmdletBinding()]
param([string]$ServiceName = 'sentinel')
$ErrorActionPreference = 'Stop'
$nssm = (Get-Command nssm.exe).Source
& $nssm stop $ServiceName confirm | Out-Null
& $nssm remove $ServiceName confirm | Out-Null
Unregister-ScheduledTask -TaskName "$ServiceName-maintenance" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed service and maintenance task. Data under C:\sentinel was left in place."
