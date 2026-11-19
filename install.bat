@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-plugin.ps1" -Action install %*
exit /b %errorlevel%
