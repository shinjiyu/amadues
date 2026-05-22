@echo off
cd /d "%~dp0\..\.."
call npm run structurizr:deps
exit /b %ERRORLEVEL%
