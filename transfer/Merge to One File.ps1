# Merge a folder of audiobook files into ONE .m4b with chapter marks.
#
# Why bother: moving 40 chapter files onto an iPhone means 40 downloads and 40
# "Save to Files" taps. One merged file is a single download, a single save, and
# a single import. The Pattern reads the chapter marks back out, so you still get
# the full chapter list.
#
#     .\"Merge to One File.ps1"                          # pick folders with a dialog
#     .\"Merge to One File.ps1" -Folder "D:\Book" -Out "D:\Send"

param(
  [string]$Folder,
  [string]$Out,
  [string]$Title,
  [string]$Author,
  [int]$Bitrate = 64
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appsRoot = Split-Path (Split-Path $here -Parent) -Parent

$ffmpeg  = Join-Path $appsRoot '_tools\ffmpeg\ffmpeg.exe'
$ffprobe = Join-Path $appsRoot '_tools\ffmpeg\ffprobe.exe'
foreach ($t in @($ffmpeg, $ffprobe)) {
  if (-not (Test-Path $t)) {
    $cmd = Get-Command (Split-Path $t -Leaf) -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Host "Missing $t" -ForegroundColor Red; Read-Host "Press Enter"; exit 1 }
  }
}

function Pick-Folder($desc) {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $desc
  $d.ShowNewFolderButton = $true
  if ($d.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $d.SelectedPath
}

if (-not $Folder) { $Folder = Pick-Folder "Pick the folder holding this audiobook's files" }
if (-not $Folder) { Write-Host "Cancelled." -ForegroundColor DarkGray; exit 0 }
if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
  Write-Host "Not a folder: $Folder" -ForegroundColor Red; Read-Host "Press Enter"; exit 1
}
if (-not $Out) { $Out = Pick-Folder "Where should the finished .m4b go?" }
if (-not $Out) { $Out = $Folder }

$exts = @('.mp3','.m4a','.m4b','.aac','.wav','.aiff','.aif','.flac','.ogg','.oga','.opus',
          '.wma','.ape','.wv','.mpc','.tta','.ac3','.au','.amr','.mka','.m4v','.mp4')
# Natural sort, so 2 comes before 10 rather than after it.
$files = @(Get-ChildItem -LiteralPath $Folder -File |
  Where-Object { $exts -contains $_.Extension.ToLower() } |
  Sort-Object @{ Expression = {
    [regex]::Replace($_.Name, '\d+', { param($m) $m.Value.PadLeft(10, '0') })
  }})

if (-not $files -or $files.Count -eq 0) {
  Write-Host "No audio files found in $Folder" -ForegroundColor Red; Read-Host "Press Enter"; exit 1
}

if (-not $Title) { $Title = Split-Path $Folder -Leaf }

Write-Host ""
Write-Host "  Merging $($files.Count) files from: $Folder" -ForegroundColor Cyan
Write-Host ""

# --- durations, for chapter boundaries ---
$chapters = @()
$cursorMs = 0.0
$i = 0
foreach ($f in $files) {
  $i++
  Write-Progress -Activity "Reading durations" -Status $f.Name -PercentComplete (100*$i/$files.Count)
  $d = & $ffprobe -v error -show_entries format=duration -of csv=p=0 -- $f.FullName 2>$null
  $sec = 0.0
  [double]::TryParse(($d | Select-Object -First 1), [ref]$sec) | Out-Null
  if ($sec -le 0) { Write-Host "  skipping (no duration): $($f.Name)" -ForegroundColor DarkYellow; continue }

  $name = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
  $name = [regex]::Replace($name, '^\s*\d+\s*[-._)]*\s*', '')   # drop a leading track number
  if (-not $name) { $name = "Chapter $($chapters.Count + 1)" }

  $chapters += [pscustomobject]@{
    File    = $f.FullName
    Title   = $name
    StartMs = [long][Math]::Round($cursorMs)
    EndMs   = [long][Math]::Round($cursorMs + $sec * 1000)
  }
  $cursorMs += $sec * 1000
}
Write-Progress -Activity "Reading durations" -Completed

if ($chapters.Count -eq 0) { Write-Host "Nothing usable." -ForegroundColor Red; Read-Host "Press Enter"; exit 1 }

$totalSec = [int]($cursorMs / 1000)
Write-Host ("  Total length: {0:d2}h {1:d2}m {2:d2}s across {3} chapters" -f `
  [int]($totalSec/3600), [int](($totalSec%3600)/60), ($totalSec%60), $chapters.Count) -ForegroundColor Green

# --- concat list ---
$listPath = Join-Path $env:TEMP ("merge-list-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
$sb = New-Object System.Text.StringBuilder
foreach ($c in $chapters) {
  $p = $c.File -replace "'", "'\''"          # concat demuxer quoting
  [void]$sb.AppendLine("file '$p'")
}
[IO.File]::WriteAllText($listPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))

# --- ffmetadata with chapters ---
function Esc-Meta($s) { ($s -replace '([=;#\\])', '\$1') -replace "`r?`n", ' ' }
$metaPath = Join-Path $env:TEMP ("merge-meta-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
$mb = New-Object System.Text.StringBuilder
[void]$mb.AppendLine(';FFMETADATA1')
[void]$mb.AppendLine("title=$(Esc-Meta $Title)")
if ($Author) { [void]$mb.AppendLine("artist=$(Esc-Meta $Author)") }
foreach ($c in $chapters) {
  [void]$mb.AppendLine('[CHAPTER]')
  [void]$mb.AppendLine('TIMEBASE=1/1000')
  [void]$mb.AppendLine("START=$($c.StartMs)")
  [void]$mb.AppendLine("END=$($c.EndMs)")
  [void]$mb.AppendLine("title=$(Esc-Meta $c.Title)")
}
[IO.File]::WriteAllText($metaPath, $mb.ToString(), (New-Object System.Text.UTF8Encoding($false)))

# --- merge ---
$safeName = ($Title -replace '[\\/:*?"<>|]', '-').Trim()
if (-not $safeName) { $safeName = 'audiobook' }
$outFile = Join-Path $Out "$safeName.m4b"

Write-Host "  Encoding to: $outFile" -ForegroundColor Cyan
Write-Host "  (mono ${Bitrate}k AAC; this takes a while for a long book)" -ForegroundColor DarkGray
Write-Host ""

& $ffmpeg -hide_banner -loglevel warning -stats `
  -f concat -safe 0 -i $listPath `
  -i $metaPath -map_metadata 1 `
  -vn -ac 1 -c:a aac -b:a "${Bitrate}k" `
  -movflags +faststart -y -- $outFile

$code = $LASTEXITCODE
Remove-Item $listPath, $metaPath -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($code -ne 0 -or -not (Test-Path $outFile)) {
  Write-Host "  Merge failed (ffmpeg exit $code)." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

$sizeMb = (Get-Item $outFile).Length / 1MB
Write-Host ("  Done: {0}  ({1:N1} MB, {2} chapters)" -f (Split-Path $outFile -Leaf), $sizeMb, $chapters.Count) -ForegroundColor Green
Write-Host ""
Write-Host "  Now run 'Send to Phone.ps1' on the folder holding this file." -ForegroundColor Cyan
Write-Host "  One download on the phone, one import, full chapter list." -ForegroundColor Cyan
Write-Host ""
