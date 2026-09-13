# restart.ps1 - one-shot: local server + tunnel + Worker BACKEND_URL update
# Usage:  pwsh .\restart.ps1            (完整模式：本地服务 + 隧道 + Worker 指向)
#         pwsh .\restart.ps1 -Local     (本地模式：只重启本地服务，不动隧道/Worker；
#                                        远端链路继续指向旧进程重启后的新服务，几乎无感)
param([switch]$Local)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$env:DENO_NO_UPDATE_CHECK = "1"   # skip deno update probe (slow direct from CN)
# Clash proxy for wrangler API/npm (set early; skip if proxy is off)
# 仅完整模式需要（wrangler 要出网）；本地模式完全不碰网络代理/隧道/Worker
if (-not $Local -and -not $env:HTTPS_PROXY) {
  $port = Get-NetTCPConnection -State Listen -LocalPort 7897 -ErrorAction SilentlyContinue
  if ($port) { $env:HTTPS_PROXY = "http://127.0.0.1:7897" }
}
Write-Host "[1/5] killing old processes..."
Get-CimInstance Win32_Process -Filter "Name='deno.exe'" |
  Where-Object { $_.CommandLine -match "main\.ts" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $Local) {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -match "tunnel --url" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host "[2/5] starting local server (hidden, log: %TEMP%\ai-proxy.log)..."
$srvLog = Join-Path $env:TEMP "ai-proxy.log"
$srvOutLog = Join-Path $env:TEMP "ai-proxy-out.log"
Remove-Item $srvLog, $srvOutLog -ErrorAction SilentlyContinue
Start-Process -FilePath "deno" -ArgumentList "run", "-A", "main.ts" `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardError $srvLog -RedirectStandardOutput $srvOutLog

for ($i = 0; $i -lt 30; $i++) {
  $ok = & curl.exe -s -m 2 -o NUL -w "%{http_code}" http://127.0.0.1:8000/
  if ($ok -eq "200") { break }
  Start-Sleep -Milliseconds 300
}
if ($ok -ne "200") { Write-Host "FAIL: local server not healthy. Check $srvLog"; exit 1 }

if ($Local) {
  Write-Host ""
  Write-Host "DONE (local mode). endpoint: http://localhost:8000/cnb/v1  (dsh provider: local)"
  Write-Host "remote chain (worker/tunnel) untouched."
  exit 0
}

Write-Host "[3/5] starting tunnel..."
$cf = "cloudflared"
if (-not (Get-Command $cf -ErrorAction SilentlyContinue)) {
  $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
}
$errLog = Join-Path $env:TEMP "cloudflared-tunnel.log"
$outLog = Join-Path $env:TEMP "cloudflared-tunnel-out.log"
Remove-Item $errLog, $outLog -ErrorAction SilentlyContinue
Start-Process -FilePath $cf -ArgumentList "tunnel", "--url", "http://localhost:8000", "--no-autoupdate" `
  -WindowStyle Hidden -RedirectStandardError $errLog -RedirectStandardOutput $outLog

Write-Host "[4/5] waiting for tunnel url (up to 120s)..."
$url = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  $m = Select-String -Path $errLog, $outLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Value; break }
}
if (-not $url) { Write-Host "FAIL: no tunnel url. Check $errLog"; exit 1 }
Write-Host "      tunnel: $url"

Write-Host "[5/5] updating Worker backend url (secret, no re-upload)..."
$url | deno run -A npm:wrangler@4.130.0 secret put BACKEND_URL 2>&1 | Select-Object -Last 1
Write-Host ""
Write-Host "DONE. endpoint: https://ai-api.hitmargin.workers.dev/cnb/v1"
Write-Host "local  endpoint: http://localhost:8000/cnb/v1  (dsh provider: local)"
Write-Host "stop everything:  Get-Process deno,cloudflared | Stop-Process"
