@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo ============================================================
echo   SYNC-AND-PUSH.bat
echo   D:\kuroneko Remote Sync and Push Script
echo   Generated: 2025-05-15 (M3 milestone)
echo ============================================================
echo.

REM ----- Step 0: Branch Check -----
for /f %%b in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%b
if not "%CURRENT_BRANCH%"=="main" (
    echo [ABORT] You are on branch: %CURRENT_BRANCH%
    echo         This script must run on the main branch.
    echo         Run: git checkout main
    pause
    exit /b 1
)
echo [OK] Current branch: main

REM ----- Step 1: Show local status -----
echo.
echo ----- Local Status -----
git status --short
echo.

REM ----- Step 2: Fetch remote -----
echo.
echo ----- Step 2: Fetching remote origin -----
git fetch origin
if errorlevel 1 (
    echo [WARN] git fetch failed. Check network / credentials.
    echo        You may continue if this is expected.
) else (
    echo [OK] Fetch complete.
)

REM ----- Step 3: Check if local is behind remote -----
echo.
echo ----- Step 3: Checking remote divergence -----
for /f %%c in ('git rev-list --count HEAD..origin/main 2^>nul') do set BEHIND=%%c
for /f %%c in ('git rev-list --count origin/main..HEAD 2^>nul') do set AHEAD=%%c

if "%BEHIND%"=="" set BEHIND=0
if "%AHEAD%"=="" set AHEAD=0

echo Local is %AHEAD% commits ahead of origin/main
echo Local is %BEHIND% commits behind origin/main

if %BEHIND% GTR 0 (
    echo.
    echo [ACTION REQUIRED] Remote has %BEHIND% new commits not in your local.
    echo   Option A: git pull --rebase origin main  ^(recommended, keeps linear history^)
    echo   Option B: git pull origin main            ^(merge commit^)
    echo.
    set /p PULL_CHOICE="Pull remote changes now? (y/n): "
    if /i "!PULL_CHOICE!"=="y" (
        echo Pulling with rebase...
        git pull --rebase origin main
        if errorlevel 1 (
            echo.
            echo [ERROR] Rebase conflict detected. Resolve manually:
            echo   1. Fix conflict files
            echo   2. git add ^<resolved files^>
            echo   3. git rebase --continue
            echo   4. Re-run this script
            pause
            exit /b 1
        )
        echo [OK] Rebase successful.
    )
)

REM ----- Step 4: Verify feature branches are merged -----
echo.
echo ----- Step 4: Verifying feature branch merge status -----
set UNMERGED=0
for %%f in (feature/heartbeat-prototype feature/heartbeat-python feature/scheduled-tasks) do (
    git branch --merged main | findstr /x "  %%f" >nul 2>&1
    if errorlevel 1 (
        echo [NOT MERGED] %%f
        set UNMERGED=1
    ) else (
        echo [MERGED] %%f
    )
)

if %UNMERGED%==1 (
    echo.
    echo [WARN] Some feature branches are not yet merged into main.
    set /p MERGE_CHOICE="Merge unmerged branches now? (y/n): "
    if /i "!MERGE_CHOICE!"=="y" (
        for %%f in (feature/heartbeat-prototype feature/heartbeat-python feature/scheduled-tasks) do (
            git branch --merged main | findstr /x "  %%f" >nul 2>&1
            if errorlevel 1 (
                echo Merging %%f ...
                git merge %%f
                if errorlevel 1 (
                    echo [ERROR] Merge conflict with %%f. Resolve and re-run.
                    pause
                    exit /b 1
                )
            )
        )
    )
)

REM ----- Step 5: Show commits to push -----
echo.
echo ----- Step 5: Commits to be pushed -----
git log --oneline origin/main..HEAD
echo.

REM Re-count after possible rebase/merge
for /f %%c in ('git rev-list --count origin/main..HEAD 2^>nul') do set AHEAD=%%c
if "%AHEAD%"=="" set AHEAD=0
echo Total: %AHEAD% commits to push

if %AHEAD%==0 (
    echo [INFO] Nothing to push. Local is up to date with origin/main.
    pause
    exit /b 0
)

REM ----- Step 6: Confirm and push -----
echo.
echo ============================================================
echo   READY TO PUSH %AHEAD% COMMITS TO origin/main
echo ============================================================
echo.
set /p CONFIRM="Type YES to push: "
if not "%CONFIRM%"=="YES" (
    echo [ABORT] Push cancelled.
    pause
    exit /b 0
)

echo.
echo Pushing to origin main...
git push origin main
if errorlevel 1 (
    echo.
    echo [ERROR] Push failed. Common causes:
    echo   - GitHub credentials not configured (run: git credential-manager configure)
    echo   - Network unreachable
    echo   - Remote rejected (force-push protection)
    echo.
    echo Try manually: git push origin main
) else (
    echo.
    echo ============================================================
    echo   PUSH SUCCESSFUL!
    echo ============================================================
    echo.
    echo ----- Post-push verification -----
    git log --oneline -5 origin/main
)

echo.
pause
