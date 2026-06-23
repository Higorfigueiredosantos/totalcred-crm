@echo off
echo Iniciando WhatsApp CRM...
start "Backend" cmd /k "cd /d "%~dp0backend" && node server.js"
timeout /t 2 /nobreak >nul
start "Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"
echo.
echo Backend: http://localhost:3001
echo Frontend: http://localhost:5173
echo.
pause
