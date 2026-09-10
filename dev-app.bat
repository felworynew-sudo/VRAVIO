@echo off
rem VRAVIO как приложение, без сборки вообще.
rem
rem Открывает дев-сервер Vite в отдельном окне браузера без вкладок и адресной строки:
rem своя иконка на панели задач, горячая замена модулей — правка в коде видна сразу.
rem Это НЕ Tauri: `window.__TAURI_INTERNALS__` здесь нет, поэтому Bridge показывает
rem выбор файлов через диалог браузера, а не содержимое диска, и кнопки окна скрыты.
rem Для всего остального (растр, вектор, аудио, видео, панели, темы) разницы нет.
rem
rem Нужно настоящее окно Tauri с теми же живыми правками — dev-desktop.bat.
setlocal
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul || set "NODE=D:\node.exe"

set "PORT=5174"
set "URL=http://localhost:%PORT%/"

rem Если сервер уже поднят — второй не запускаем.
powershell -NoProfile -Command "exit (Test-NetConnection -ComputerName localhost -Port %PORT% -InformationLevel Quiet) -eq $true" >nul 2>nul
if errorlevel 1 (
  echo Дев-сервер уже слушает порт %PORT%.
) else (
  echo Запускаю дев-сервер на порту %PORT%...
  start "VRAVIO dev server" /min /d "%~dp0apps\web" "%NODE%" "node_modules\vite\bin\vite.js" --port %PORT% --strictPort
  powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(60); while((Get-Date) -lt $deadline){ if(Test-NetConnection -ComputerName localhost -Port %PORT% -InformationLevel Quiet){ exit 0 }; Start-Sleep -Milliseconds 400 }; exit 1"
  if errorlevel 1 (
    echo Дев-сервер не поднялся за минуту. Смотрите его окно.
    pause
    exit /b 1
  )
)

set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
  start "" "%BROWSER%" --app=%URL% --window-size=1600,1000 --user-data-dir="%TEMP%\vravio-app-window"
) else (
  echo Не нашёл Edge или Chrome — открываю обычным браузером.
  start "" %URL%
)
endlocal
