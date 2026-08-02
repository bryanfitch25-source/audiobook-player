# Deploys this folder to GitHub Pages.
#
# Run once:   gh auth login
# Then:       .\deploy-github.ps1
#
# Re-running it later pushes updates to the same URL.

# Deliberately NOT 'Stop': git writes ordinary progress and line-ending notices
# to stderr, and Windows PowerShell turns those into terminating errors. Exit
# codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'

$RepoName = 'audiobook-player'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

Write-Host "Checking GitHub sign-in..." -ForegroundColor Cyan
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "You are not signed in to GitHub." -ForegroundColor Yellow
  Write-Host "Run this first, then re-run this script:" -ForegroundColor Yellow
  Write-Host "    gh auth login" -ForegroundColor White
  exit 1
}

$user = (gh api user --jq '.login' 2>$null).Trim()
if (-not $user) { Fail "Could not read your GitHub username." }
Write-Host "Signed in as $user" -ForegroundColor Green

if (-not (Test-Path (Join-Path $here '.git'))) {
  Write-Host "Initialising repository..." -ForegroundColor Cyan
  git init -b main 2>&1 | Out-Null
}

# ACCOUNTS.txt holds your account details and must never be published.
# GitHub Pages needs a public repo on a free plan, so this stays excluded.
@('ACCOUNTS.txt', '*.zip', '.DS_Store', 'Thumbs.db') |
  Set-Content -Encoding utf8 (Join-Path $here '.gitignore')

# Keep git quiet about line endings and treat the wasm as binary.
@('* text=auto', '*.wasm binary', '*.png binary') |
  Set-Content -Encoding utf8 (Join-Path $here '.gitattributes')

# Commits need an author. Set it for this repo only, so global git config is
# left alone, and use the GitHub noreply address to keep a real email private.
$haveName = git config user.name 2>$null
if (-not $haveName) {
  $uid = (gh api user --jq '.id' 2>$null).Trim()
  git config user.name $user 2>&1 | Out-Null
  git config user.email "$uid+$user@users.noreply.github.com" 2>&1 | Out-Null
  Write-Host "Set commit identity for this repo to $user (noreply email)." -ForegroundColor DarkGray
}

$tracked = git ls-files ACCOUNTS.txt 2>$null
if ($tracked) {
  git rm --cached ACCOUNTS.txt --quiet 2>&1 | Out-Null
  Write-Host "Removed ACCOUNTS.txt from the repo." -ForegroundColor Yellow
}

git add -A 2>&1 | Out-Null
git diff --cached --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  git commit -m "Deploy The Pattern audiobook player" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Commit failed." }
  Write-Host "Committed changes." -ForegroundColor Green
} else {
  Write-Host "No changes to commit." -ForegroundColor DarkGray
}

gh repo view "$user/$RepoName" 2>&1 | Out-Null
$exists = ($LASTEXITCODE -eq 0)

if (-not $exists) {
  Write-Host "Creating public repo $user/$RepoName..." -ForegroundColor Cyan
  Write-Host "(GitHub Pages requires a public repo unless you have GitHub Pro." -ForegroundColor DarkGray
  Write-Host " Only the app is pushed. ACCOUNTS.txt is excluded.)" -ForegroundColor DarkGray
  gh repo create $RepoName --public --source=. --remote=origin 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Could not create the repository." }
} else {
  $remotes = git remote 2>$null
  if ($remotes -notcontains 'origin') {
    git remote add origin "https://github.com/$user/$RepoName.git" 2>&1 | Out-Null
  }
}

Write-Host "Pushing (the 32MB converter takes a moment)..." -ForegroundColor Cyan
git push -u origin main --force 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Push failed. Run 'git push -u origin main' to see why." }
Write-Host "Pushed." -ForegroundColor Green

Write-Host "Enabling GitHub Pages..." -ForegroundColor Cyan
gh api "repos/$user/$RepoName/pages" -X POST -f "source[branch]=main" -f "source[path]=/" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  # Already enabled: update instead of create.
  gh api "repos/$user/$RepoName/pages" -X PUT -f "source[branch]=main" -f "source[path]=/" 2>&1 | Out-Null
}

Write-Host ""
Write-Host "Done. Live in a minute or two at:" -ForegroundColor Green
Write-Host "    https://$user.github.io/$RepoName/" -ForegroundColor White
Write-Host ""
Write-Host "On your iPhone: open that URL in Safari, tap Share, then Add to Home Screen." -ForegroundColor Cyan
Write-Host "Launch it from the home screen icon so iOS keeps your library." -ForegroundColor Cyan
