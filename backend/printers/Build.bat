@echo off
:: Headless rebuild: turns every "Presets <Name>" folder next to this file into
:: its <name>.xml (e.g. edgar.xml, george.xml) without opening the GUI.
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

echo Baue alle Drucker-XML neu ...
%PY% "Converter.py" --build
echo.
pause
endlocal
