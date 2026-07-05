# One-time setup: create .env and verify GitHub credentials.
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvExample = Join-Path $ProjectRoot ".env.example"
$EnvFile = Join-Path $ProjectRoot ".env"

if (-not (Test-Path $EnvFile)) {
  Copy-Item $EnvExample $EnvFile
  Write-Host "Created .env from .env.example"
}

function Get-DotEnvValue([string]$Key) {
  if (-not (Test-Path $EnvFile)) { return $null }
  foreach ($line in Get-Content $EnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -match "^\s*$Key\s*=\s*(.+)$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Process")
if (-not $token) { $token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User") }
if (-not $token) { $token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Machine") }
if (-not $token) { $token = Get-DotEnvValue "GITHUB_TOKEN" }
if (-not $token) { $token = Get-DotEnvValue "GH_TOKEN" }

$repo = Get-DotEnvValue "GITHUB_REPO"
if (-not $repo) {
  $repo = Read-Host "GitHub repo (owner/name, e.g. username/mmtvpro)"
  Add-Content $EnvFile "`nGITHUB_REPO=$repo"
}

if (-not $token -or $token -eq "ghp_your_token_here") {
  Write-Host "GITHUB_TOKEN is missing in .env and environment."
  Write-Host "Add your token to $EnvFile then run: npm run sync"
  exit 1
}

Write-Host "Repo: $repo"
Write-Host "Token: configured (length $($token.Length))"
Write-Host "Test sync: npm run sync"
Write-Host "Start 5-minute loop: npm run sync:loop"
