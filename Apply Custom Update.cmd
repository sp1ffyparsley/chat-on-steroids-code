@echo off
setlocal
title Chat On Steroids - Apply Qualified Custom Update
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-custom.ps1" -QualifiedPrebuilt -WaitForSafeQuit
if errorlevel 1 (
  echo.
  echo The update command returned an error. Read the exact state above; no additional action was assumed by this wrapper.
  echo Rollback is separate and deliberate; it was not run automatically.
  pause
  exit /b 1
)
echo.
echo Update complete. The exact qualified build was verified after install; companion reload was requested automatically.
pause
exit /b 0
