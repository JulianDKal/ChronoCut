@echo off
:: Starts Converter.py WITH a console window so errors / tracebacks stay visible.
setlocal
cd /d "%~dp0"

:: Pick a Python interpreter: portable WinPython first, then python / py from PATH.
set "PY="
for /d %%D in (..\WPy* ..\..\WPy* WPy*) do if exist "%%~fD\python\python.exe" set "PY=%%~fD\python\python.exe"
if not defined PY for %%P in (python.exe) do if not "%%~$PATH:P"=="" set "PY=python"
if not defined PY for %%P in (py.exe)     do if not "%%~$PATH:P"=="" set "PY=py"

if not defined PY (
  echo Kein Python gefunden.
  echo Bitte Python installieren oder oben den WinPython-Pfad anpassen.
  pause
  exit /b 1
)

echo Starte Converter.py ...
%PY% "Converter.py"
echo.
echo Converter beendet.
pause
endlocal
