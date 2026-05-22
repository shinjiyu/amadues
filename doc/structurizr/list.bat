@echo off
cd /d "%~dp0"
call "%~dp0run-war.bat" list -workspace workspace.dsl
pause
