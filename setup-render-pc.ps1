# setup-render-pc.ps1 — One-time Windows setup for the LAN GPU Render Worker
# Run in PowerShell as Administrator from inside the cloned repo folder:
#   powershell -ExecutionPolicy Bypass -File .\setup-render-pc.ps1
param(
  [int]$Port = 8787,
  [string]$LanSubnet = "LocalSubnet",
  [switch]$SkipWinget
)

$ErrorActionPreference = "Stop"
$RepoDir = $PSScriptRoot
Set-Location $RepoDir

if (-not $SkipWinget) {
  Write-Host "`n=== 1) Installing Node.js LTS, FFmpeg, and Google Chrome ==="
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  winget install -e --id Google.Chrome --accept-source-agreements --accept-package-agreements

  # Refresh PATH for the current PowerShell session
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "`n=== 2) Installing puppeteer-core ==="
npm install

Write-Host "`n=== 3) Opening Windows Firewall port $Port for $LanSubnet (Private network only) ==="
Remove-NetFirewallRule -DisplayName "LAN GPU Render Worker" -ErrorAction SilentlyContinue
New-NetFirewallRule `
  -DisplayName "LAN GPU Render Worker" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -RemoteAddress $LanSubnet `
  -Profile Private | Out-Null

Write-Host "`n=== 4) Generating local shared token (.token) ==="
$TokenFile = Join-Path $RepoDir ".token"
if (-not (Test-Path $TokenFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToHexString($bytes).ToLower() | Set-Content -NoNewline $TokenFile
}
$Token = (Get-Content $TokenFile -Raw).Trim()

Write-Host "`n=== 5) Installing Windows Startup auto-launch shortcut ==="
$StartupDir = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupDir "LAN-GPU-Render-Worker.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = Join-Path $RepoDir "start-worker.bat"
$Shortcut.WorkingDirectory = $RepoDir
$Shortcut.WindowStyle = 7 # Minimized
$Shortcut.Save()
Write-Host "Startup shortcut created: $ShortcutPath"

Write-Host "`n=== 6) Verifying GPU, NVENC, and Headless Chrome WebGL ==="
node (Join-Path $RepoDir "test-gpu.mjs")

$LanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -match "^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)" -and
    $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback|Virtual"
  } |
  Select-Object -First 1).IPAddress

if (-not $LanIp) { $LanIp = "<DESKTOP_LAN_IP>" }
$MdnsHost = "$($env:COMPUTERNAME).local"

Write-Host "`n=== 7) Starting worker now ==="
Start-Process -FilePath (Join-Path $RepoDir "start-worker.bat") -WorkingDirectory $RepoDir

Write-Host "`n============================================================"
Write-Host "SETUP COMPLETE! Worker is now running and auto-starts on boot."
Write-Host ""
Write-Host "Copy these two lines into .env on your Linux laptop:"
Write-Host "  RENDER_HOST=http://${LanIp}:${Port}"
Write-Host "  RENDER_TOKEN=${Token}"
Write-Host ""
Write-Host "Tip: If your IP changes after reboot, you can also try mDNS:"
Write-Host "  RENDER_HOST=http://${MdnsHost}:${Port}"
Write-Host "============================================================`n"
