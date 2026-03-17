@echo off
echo ============================================
echo   MailGuard Pro v7 - Starting API Server
echo ============================================
echo.

cd /d "%~dp0"

echo [1/2] Installing dependencies...
pip install -r requirements.txt

echo.
echo [2/2] Starting server on http://localhost:5000
echo        Press CTRL+C to stop
echo.
python server.py
pause
