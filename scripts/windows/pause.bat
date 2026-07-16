@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pause.ps1" %*
if errorlevel 1 pause
