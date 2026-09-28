@echo off
rem ============================================================
rem  Dotobe desktop client - one-click build launcher
rem  This BAT is ASCII-only; all logic lives in build_client.ps1
rem  Double-click this file to build & bundle the client.
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_client.ps1"
pause
