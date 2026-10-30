@echo off
setlocal
title Chat On Steroids - Explicit Custom Rollback
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-custom.ps1" -Rollback -WaitForSafeQuit
if errorlevel 1 (
  echo.
  echo The rollback command returned an error. Read the exact state above; no additional action was assumed by this wrapper.
  pause
  exit /b 1
)
echo.
echo Rollback complete. The exact private 2.1.13 program baseline was verified; user data was retained.
pause
exit /b 0
