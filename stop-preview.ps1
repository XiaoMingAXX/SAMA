$taskRecordPath = Join-Path $PSScriptRoot 'artifacts\preview-process.json'
if (-not (Test-Path -LiteralPath $taskRecordPath)) {
    Write-Host '没有本任务启动的后台预览进程记录。手动启动的服务请在对应窗口按 Ctrl+C。'
    exit 0
}
$taskRecord = Get-Content -LiteralPath $taskRecordPath -Raw | ConvertFrom-Json
$taskProcess = Get-Process -Id $taskRecord.pid -ErrorAction SilentlyContinue
if ($null -eq $taskProcess) { Write-Host '后台预览服务已经停止。'; exit 0 }
$taskCommand = (Get-CimInstance Win32_Process -Filter "ProcessId = $($taskRecord.pid)").CommandLine
if ($taskProcess.ProcessName -ne 'node' -or $taskProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $taskRecord.startedAtTicks -or $taskCommand -notmatch 'server\.mjs') {
    Write-Host '进程记录与当前进程不匹配，未停止任何进程。'
    exit 1
}
Stop-Process -Id $taskProcess.Id
Write-Host 'LOAM 后台预览服务已停止。下次可双击 start.cmd 重新启动。'
exit 0
