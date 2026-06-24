@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Starting Bingo server...
start "Bingo Server" cmd /k "npm start"
timeout /t 3 >nul
echo Opening public tunnel...
echo.
echo ============================================================
echo  Look for the  https://xxxx.trycloudflare.com  address below.
echo  Open  THAT-ADDRESS/host.html  in your browser to host.
echo ============================================================
echo.
cloudflared.exe tunnel --url http://localhost:3000
pause
