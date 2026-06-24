@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo ====================================================
echo   Bingo Party  -  http://localhost:3000/host.html
echo ====================================================
echo.
call npm start
pause
