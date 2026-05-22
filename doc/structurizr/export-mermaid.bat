@echo off
cd /d "%~dp0"
call "%~dp0run-war.bat" export -workspace workspace.dsl -format mermaid
echo.
echo Done. Files: structurizr-*.mmd in this folder.
pause
