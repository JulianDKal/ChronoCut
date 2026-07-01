@echo off
setlocal EnableExtensions
title ChronoCut - Setup und Start
cd /d "%~dp0"

echo ============================================
echo   ChronoCut - Setup und Start
echo ============================================
echo.

rem ---------- Python finden ----------
set "PYTHON_CMD="
python --version >nul 2>&1
if %errorlevel%==0 set "PYTHON_CMD=python"
if "%PYTHON_CMD%"=="" (
    py -3 --version >nul 2>&1
    if %errorlevel%==0 set "PYTHON_CMD=py -3"
)
if "%PYTHON_CMD%"=="" (
    echo [FEHLER] Python 3 wurde nicht gefunden.
    echo Bitte installiere es von https://www.python.org/downloads/
    echo Wichtig: beim Setup "Add python.exe to PATH" aktivieren.
    echo ^(Falls "python" trotzdem den Microsoft-Store oeffnet: dort ist
    echo   kein echtes Python installiert - bitte die offizielle Version
    echo   von python.org verwenden.^)
    echo.
    pause
    exit /b 1
)
echo [OK] Python gefunden.

rem ---------- Node / npm finden ----------
where npm >nul 2>&1
if not %errorlevel%==0 (
    echo [FEHLER] Node.js / npm wurde nicht gefunden.
    echo Bitte installiere Node.js von https://nodejs.org/ ^(LTS-Version^)
    echo und starte danach diese Datei erneut.
    echo.
    pause
    exit /b 1
)
echo [OK] npm gefunden.
echo.

rem ---------- Backend: virtuelle Umgebung + Pakete ----------
echo ---- Backend wird vorbereitet ----
if not exist "backend\venv\Scripts\python.exe" (
    echo Erstelle virtuelle Umgebung...
    %PYTHON_CMD% -m venv "backend\venv"
    if not exist "backend\venv\Scripts\python.exe" (
        echo [FEHLER] Erstellen der virtuellen Umgebung fehlgeschlagen.
        pause
        exit /b 1
    )
)

echo Installiere Backend-Abhaengigkeiten ^(kann beim ersten Mal dauern^)...
"backend\venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
"backend\venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt"
if not %errorlevel%==0 (
    echo [FEHLER] Installation der Backend-Abhaengigkeiten fehlgeschlagen.
    pause
    exit /b 1
)
echo [OK] Backend bereit.
echo.

rem ---------- Frontend: npm-Pakete ----------
echo ---- Frontend wird vorbereitet ----
call npm install --prefix "frontend"
if not %errorlevel%==0 (
    echo [FEHLER] "npm install" fehlgeschlagen.
    pause
    exit /b 1
)
echo [OK] Frontend bereit.
echo.

rem ---------- Server starten (falls nicht schon aktiv) ----------
echo ---- Server werden gestartet ----

rem netstat/findstr would also match stale TIME_WAIT/CLOSE_WAIT leftovers from an
rem already-closed server (e.g. right after closing the backend window and
rem re-running this file) - that false positive made the script skip starting
rem a backend that wasn't actually running anymore. PowerShell's -State Listen
rem checks the real socket state, not just "is this port mentioned anywhere".
set "BACKEND_RUNNING="
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel%==0 set "BACKEND_RUNNING=1"

set "FRONTEND_RUNNING="
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel%==0 set "FRONTEND_RUNNING=1"

if defined BACKEND_RUNNING (
    echo Backend laeuft bereits auf Port 8000 - ueberspringe Start.
) else (
    start "ChronoCut Backend" /D "%~dp0backend" cmd /k "venv\Scripts\uvicorn.exe main:app --reload"
    echo Backend gestartet: http://localhost:8000/
)

if defined FRONTEND_RUNNING (
    echo Frontend laeuft bereits auf Port 5173 - ueberspringe Start.
) else (
    start "ChronoCut Frontend" /D "%~dp0frontend" cmd /k "npm run dev"
    echo Frontend gestartet: http://localhost:5173/
)

echo.
echo Warte, bis der Frontend-Server bereit ist...
ping -n 7 127.0.0.1 >nul
start "" "http://localhost:5173/"

echo.
echo ============================================
echo   ChronoCut laeuft:
echo     Frontend: http://localhost:5173/
echo     Backend:  http://localhost:8000/
echo.
echo   Zum Beenden einfach die beiden Fenster
echo   "ChronoCut Backend" und "ChronoCut Frontend"
echo   wieder schliessen.
echo ============================================
echo.
pause
