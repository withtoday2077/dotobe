@echo off
rem ============================================================
rem  途变客户端 · NSIS 安装包打包（双击运行）
rem  如需小体积包（不内嵌 WebView2）：
rem    build_installer.bat -NoWebView2
rem ============================================================
setlocal
set PS1=%~dp0build_installer.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo 打包未完成，请查看上方错误信息。
)
echo.
pause
exit /b %EXITCODE%
