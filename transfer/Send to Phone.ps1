# Beam audiobooks from this PC to your iPhone over Wi-Fi.
#
# Right-click this file and choose "Run with PowerShell", or run it from a
# terminal. Optionally pass the folder to share:
#
#     .\"Send to Phone.ps1" "D:\Audiobooks\The Eye of the World"

param([string]$Folder, [int]$Port = 8200)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Prefer the Node bundled alongside these projects, else whatever is on PATH.
$node = Join-Path (Split-Path (Split-Path $here -Parent) -Parent) '_tools\node\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source } else {
    Write-Host "Node was not found. Install Node.js, or put node.exe in _tools\node." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
  }
}

# Ask for the folder if it was not supplied.
if (-not $Folder) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "Pick the folder holding the audiobook files"
  $dlg.ShowNewFolderButton = $false
  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "Cancelled." -ForegroundColor DarkGray
    exit 0
  }
  $Folder = $dlg.SelectedPath
}

if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
  Write-Host "Not a folder: $Folder" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

$wifi = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Sort-Object { if ($_.InterfaceAlias -like '*Wi-Fi*') { 0 } else { 1 } } |
  Select-Object -First 1

Write-Host ""
Write-Host "  ============================================" -ForegroundColor DarkYellow
if ($wifi) {
  Write-Host "   In Chrome on your iPhone, go to:" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "       http://$($wifi.IPAddress):$Port" -ForegroundColor White -BackgroundColor DarkBlue
  Write-Host ""
}
Write-Host "  ============================================" -ForegroundColor DarkYellow
Write-Host ""
Write-Host "  First run only: Windows may ask to allow Node" -ForegroundColor DarkGray
Write-Host "  through the firewall. Tick Private networks." -ForegroundColor DarkGray

& $node (Join-Path $here 'beam-server.js') $Folder $Port
