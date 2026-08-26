@echo off
chcp 65001 > nul
title 洛谷 Markdown 编辑器启动器

echo ========================================================
echo        洛谷 Markdown & KaTeX 实时预览编辑器
echo ========================================================
echo.
echo [1] 正在检查运行环境...

python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo [2] 检测到 Python 环境，正在启动桌面服务...
    python app.py
) else (
    echo [2] 未检测到 Python，正在直接以脱机模式启动单文件版编辑器...
    start "" "LuoguMarkdownEditor.html"
)

pause
