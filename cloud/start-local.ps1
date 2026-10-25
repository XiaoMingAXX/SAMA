param([switch]$InitDemo,[switch]$Stop,[int]$WebPort=3180,[int]$GatewayPort=3189,[string]$NodePath)
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskPreview=Join-Path $taskRoot '.preview'
$taskState=Join-Path $taskPreview 'service.json'
$taskServer=Join-Path $taskRoot 'server.mjs'
$taskNode=$NodePath
if (!$taskNode) { $taskNode=(Get-Command node -ErrorAction SilentlyContinue).Source }
if (!$taskNode -or !(Test-Path -LiteralPath $taskNode)) { throw 'Install Node.js 24.15+ or supply -NodePath.' }
$taskVersion=[version]((& $taskNode --version).TrimStart('v'))
if ($taskVersion -lt [version]'24.15.0') { throw 'Node.js 24.15+ is required.' }
if (Test-Path -LiteralPath $taskState) {
  $taskRecorded=Get-Content -Raw -LiteralPath $taskState | ConvertFrom-Json
  $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRecorded.pid)" -ErrorAction SilentlyContinue
  if ($taskProcess -and $taskProcess.ExecutablePath -eq $taskRecorded.node -and $taskProcess.CommandLine.Contains($taskServer) -and (Get-Process -Id $taskRecorded.pid).StartTime.ToUniversalTime().ToString('o') -eq $taskRecorded.started) {
    if ($Stop) { Stop-Process -Id $taskRecorded.pid; Remove-Item -LiteralPath $taskState; Write-Output 'Stopped this local SAMA preview.'; exit }
    Write-Output "Local SAMA is already running: http://127.0.0.1:$($taskRecorded.webPort)"; exit
  }
}
if ($Stop) { Write-Output 'No matching local preview process was found.'; exit }
New-Item -ItemType Directory -Path $taskPreview -Force | Out-Null
$env:CLOUD_DATA_DIR=Join-Path $taskPreview 'data'
$env:SAMA_OBJECT_STORE='local'
$env:NODE_ENV='development'
$env:HOST='127.0.0.1'
$env:WEB_PORT=[string]$WebPort
$env:PORT=[string]$GatewayPort
$env:SAMA_PUBLIC_ORIGIN="http://127.0.0.1:$WebPort"
if ($InitDemo -and !(Test-Path -LiteralPath (Join-Path $env:CLOUD_DATA_DIR 'warehouse.sqlite'))) {
  & $taskNode (Join-Path $taskRoot 'manage.mjs') demo
  if ($LASTEXITCODE -ne 0) { throw 'Demo initialization failed.' }
}
$taskChild=Start-Process -FilePath $taskNode -ArgumentList ('"'+$taskServer+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskPreview 'stdout.log') -RedirectStandardError (Join-Path $taskPreview 'stderr.log') -PassThru
Start-Sleep -Milliseconds 1200
$taskChild.Refresh()
if ($taskChild.HasExited) { Get-Content -LiteralPath (Join-Path $taskPreview 'stderr.log'); throw 'Preview failed to start.' }
@{pid=$taskChild.Id;node=$taskNode;server=$taskServer;started=$taskChild.StartTime.ToUniversalTime().ToString('o');webPort=$WebPort;gatewayPort=$GatewayPort} | ConvertTo-Json | Set-Content -LiteralPath $taskState -Encoding utf8
Write-Output "Local SAMA: http://127.0.0.1:$WebPort"
Write-Output "Data and demo credentials (if initialized): $env:CLOUD_DATA_DIR"
