@echo off
rem Настоящее окно VRAVIO (Tauri) с живыми правками — без пересборки на каждое изменение.
rem
rem Оболочка на Rust собирается один раз в debug и дальше переиспользуется: следующий
rem запуск — секунды. Весь интерфейс приходит из дев-сервера Vite, поэтому правка в
rem apps/web видна в окне сразу, без cargo. Пересборка нужна только если менялся Rust
rem (apps/desktop/src-tauri) или права плагинов.
rem
rem Первый запуск на этой машине — долгий: debug-сборка дерева зависимостей Tauri.
rem Пока она идёт, тот же интерфейс доступен мгновенно через dev-app.bat.
setlocal
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul || set "NODE=D:\node.exe"

set "PORT=5174"

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

rem `beforeDevCommand` в tauri.conf.json зовёт pnpm, которого нет в PATH этой машины,
rem а сервер уже поднят выше — поэтому хук отключён на этот запуск.
rem Один поток компиляции: на 8 ГБ параллельная сборка упирается в лимит выделения
rem памяти и падает с «файл подкачки слишком мал» (мастер-план, раздел 34.2).
cd apps\desktop
set CARGO_BUILD_JOBS=1
"%NODE%" node_modules\@tauri-apps\cli\tauri.js dev --config "{\"build\":{\"beforeDevCommand\":\"\"}}"
if errorlevel 1 pause
endlocal
