# Registers a Windows Task Scheduler job to scrape and push every 5 minutes.
# Run once as Administrator from project root:
#   powershell -ExecutionPolicy Bypass -File scripts/install-sync-task.ps1

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node).Source
$TaskName = "MMTVPro-GitHub-Sync"
$WrapperScript = Join-Path $PSScriptRoot "run-sync.ps1"

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperScript`"" `
  -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Scrape and push mmtvpro data to GitHub every 5 minutes" `
  -Force

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Project: $ProjectRoot"
Write-Host "Wrapper: $WrapperScript"
Write-Host "Configure credentials in .env (copy from .env.example), then run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/setup-github.ps1"
