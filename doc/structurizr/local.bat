@echo off
cd /d "%~dp0"

set PORT=8081
set "WAR=%~dp0.tools\structurizr.war"

if not exist "%WAR%" (
    echo ERROR: missing %WAR%
    pause
    exit /b 1
)

where java >nul 2>&1
if errorlevel 1 (
    echo ERROR: java not found. Install JDK 21+ and open a new cmd window.
    pause
    exit /b 1
)

echo Freeing port %PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo   stopping PID %%P
    taskkill /PID %%P /F >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo.
echo Structurizr local - Kuroneko workspace
echo   Open:  http://127.0.0.1:%PORT%
echo   DSL:   %CD%\workspace.dsl
echo   Log:   %CD%\.structurizr\logs\structurizr.log
echo   Stop:  Ctrl+C  or  stop-local.bat
echo.
echo Starting... keep this window open.
echo.

java -Dserver.port=%PORT% -jar "%WAR%" local .
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
    echo ERROR: server exited with code %EXITCODE%
    echo See log: %CD%\.structurizr\logs\structurizr.log
) else (
    echo Server stopped.
)
echo.
pause
exit /b %EXITCODE%
