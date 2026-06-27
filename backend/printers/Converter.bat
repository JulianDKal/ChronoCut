@echo off
:: Starts the DAT -> XML/CSV Converter (Converter.py) that sits next to this file.
setlocal
cd /d "%~dp0"

:: Pick a Python interpreter:
::  1) a portable WinPython bundled with the project (adjust the WPy* path if yours differs)
::  2) otherwise pythonw / pyw from PATH  (pythonw = no extra console window)
set "PY="
for /d %%D in (..\WPy* ..\..\WPy* WPy*) do if exist "%%~fD\python\pythonw.exe" set "PY=%%~fD\python\pythonw.exe"
if not defined PY for %%P in (pythonw.exe) do if not "%%~$PATH:P"=="" set "PY=pythonw"
if not defined PY for %%P in (pyw.exe)     do if not "%%~$PATH:P"=="" set "PY=pyw"

if not defined PY (
  echo Kein Python gefunden.
  echo Bitte Python installieren oder oben den WinPython-Pfad anpassen.
  pause
  exit /b 1
)

start "" %PY% "Converter.py"
endlocal
