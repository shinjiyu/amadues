@echo off
cd /d "%~dp0"
call "%~dp0run-war.bat" validate -workspace workspace.dsl
exit /b %ERRORLEVEL%
