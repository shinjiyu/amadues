@echo off
if "%PORT%"=="" set PORT=8081
echo Stopping anything on port %PORT%...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo   taskkill PID %%P
    taskkill /PID %%P /F >nul 2>&1
    set FOUND=1
)
if "%FOUND%"=="0" (
    echo   nothing on %PORT%
) else (
    echo   done
)
timeout /t 2 /nobreak >nul
echo.
pause
