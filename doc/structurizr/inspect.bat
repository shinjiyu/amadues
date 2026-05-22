@echo off
cd /d "%~dp0"
call "%~dp0run-war.bat" inspect -workspace workspace.dsl -severity error,warning
echo.
echo Exit code = violation count. See modules-catalog.md for horizon contracts.
exit /b %ERRORLEVEL%
