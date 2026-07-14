# Registers a Windows Task Scheduler job to scrape movies every 15 days.
# Run once as Administrator from project root:
#   powershell -ExecutionPolicy Bypass -File scripts/install-movies-task.ps1

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskName = "MMTVPro-Movies-Sync"
$WrapperScript = Join-Path $PSScriptRoot "run-movies-sync.ps1"
$IntervalDays = 15

if ($env:MOVIES_SYNC_INTERVAL_DAYS) {
  $IntervalDays = [int]$env:MOVIES_SYNC_INTERVAL_DAYS
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperScript`"" `
  -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Days $IntervalDays) `
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
  -Description "Scrape mycinema.asia movies every $IntervalDays days and push movies.json only when changed" `
  -Force

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Interval: every $IntervalDays days"
Write-Host "Project: $ProjectRoot"
Write-Host "Optional: set MYCINEMA_TOKEN in .env for m3u8 watch links"
