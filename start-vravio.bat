@echo off
setlocal
cd /d "%~dp0"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo VRAVIO requires pnpm. Install Node.js and run: npm install -g pnpm
  pause
  exit /b 1
)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4173/'"
call pnpm --filter @vravio/web dev --host 127.0.0.1
if errorlevel 1 pause
endlocal
