@echo off
chcp 65001 >nul
title Linked Bridge (Telegram - Claude Code)
cd /d "%~dp0.."
echo.
echo   [Linked bridge] Telegram -^> this PC's Claude Code. Close this window to stop.
echo.
:loop
node "%~dp0tg_bridge.cjs"
echo.
echo   [bridge stopped - restarting in 10s. Close this window to quit]
timeout /t 10 >nul
goto loop
