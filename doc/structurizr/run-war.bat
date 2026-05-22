@echo off
cd /d "%~dp0"

set "WAR=%~dp0.tools\structurizr.war"
if not exist "%WAR%" (
    echo ERROR: missing %WAR%
    echo Download: https://download.structurizr.com/structurizr.war
    exit /b 1
)

where java >nul 2>&1
if errorlevel 1 (
    echo ERROR: java not found. Install JDK 21+ and open a new cmd window.
    exit /b 1
)

if "%~1"=="" (
    java -jar "%WAR%" help
    exit /b %ERRORLEVEL%
)

if /i "%~1"=="local" (
    if not "%~2"=="" (
        java -jar "%WAR%" local "%~2"
        exit /b %ERRORLEVEL%
    )
    java -Dserver.port=8081 -jar "%WAR%" local .
    exit /b %ERRORLEVEL%
)

java -jar "%WAR%" %*
exit /b %ERRORLEVEL%
