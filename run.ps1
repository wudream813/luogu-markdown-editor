# PowerShell Launcher for Luogu Markdown Editor
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       洛谷 Markdown & KaTeX 实时预览编辑器 (Windows)" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue

if ($null -ne $pythonCmd) {
    Write-Host "[√] 检测到 Python，正在启动本地服务与浏览器..." -ForegroundColor Yellow
    python app.py
} else {
    Write-Host "[√] 正在直接打开单文件免安装离线版编辑器..." -ForegroundColor Yellow
    Start-Process "LuoguMarkdownEditor.html"
}
