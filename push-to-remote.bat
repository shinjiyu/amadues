@echo off
chcp 65001 >nul 2>&1
echo ============================================
echo   Push to Remote - Guided Handoff Script
echo ============================================
echo.

cd /d D:\kuroneko

REM --- Step 1: Branch Check ---
for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%b
if not "%CURRENT_BRANCH%"=="main" (
    echo [ABORT] Current branch is '%CURRENT_BRANCH%', expected 'main'.
    echo         Switch to main before pushing: git checkout main
    pause
    exit /b 1
)
echo [OK] On branch 'main'

REM --- Step 2: Ahead Count ---
for /f "tokens=*" %%c in ('git rev-list --count origin/main..HEAD') do set AHEAD=%%c
echo [INFO] main is %AHEAD% commits ahead of origin/main
echo.

REM --- Step 3: Show Commits ---
echo --- Commits to be pushed ---
git log --oneline origin/main..HEAD
echo.

REM --- Step 4: Confirm ---
echo About to push %AHEAD% commits to origin/main.
set /p CONFIRM=Type YES to proceed: 
if not "%CONFIRM%"=="YES" (
    echo [ABORT] Push cancelled by user.
    pause
    exit /b 1
)

REM --- Step 5: Push ---
echo.
echo [EXEC] git push origin main
git push origin main
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Push failed! Check network access and credentials.
    pause
    exit /b 1
)

echo.
echo [OK] Push completed successfully!

REM --- Step 6: Verify ---
echo.
echo --- Post-push verification ---
git log --oneline -1 origin/main
echo.

REM --- Optional: Cleanup feature branches ---
echo.
set /p CLEANUP=Delete local feature branches? (YES/no): 
if "%CLEANUP%"=="YES" (
    git branch -d feature/heartbeat-prototype 2>nul
    git branch -d feature/heartbeat-python 2>nul
    git branch -d feature/scheduled-tasks 2>nul
    echo [OK] Local feature branches deleted.
)

echo.
echo Done. Press any key to exit.
pause >nul
