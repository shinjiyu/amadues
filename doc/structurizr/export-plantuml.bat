@echo off
cd /d "%~dp0"
call "%~dp0run-war.bat" export -workspace workspace.dsl -format plantuml
echo.
echo Done. Files: structurizr-*.puml in this folder.
pause
