@echo off
setlocal enableextensions enabledelayedexpansion
title Accrual Engine - Sandbox Deploy
echo ============================================================
echo   Accrual Engine  -  one-shot sandbox deploy
echo   This handles the folder, Java, install and deploy for you.
echo ============================================================
echo.

REM --- 1. Use an unprotected folder (OneDrive blocks npm) --------------
if not exist C:\dev mkdir C:\dev
cd /d C:\dev

REM --- 2. Get or update the project -----------------------------------
if exist C:\dev\crunchbase-a\.git (
    echo [1/5] Updating existing project...
    cd /d C:\dev\crunchbase-a
    git fetch origin
    git checkout claude/netsuite-accrual-engine-m76xir
    git pull origin claude/netsuite-accrual-engine-m76xir
) else (
    echo [1/5] Downloading project from GitHub...
    git clone https://github.com/paulpatrick/crunchbase-a.git
    cd /d C:\dev\crunchbase-a
    git checkout claude/netsuite-accrual-engine-m76xir
)
if errorlevel 1 goto :fail

cd /d C:\dev\crunchbase-a\accrual-engine

REM --- 3. Java check (SuiteCloud needs a JDK) -------------------------
echo.
echo [2/5] Checking for Java...
java -version >nul 2>&1
if errorlevel 1 (
    echo       Java not found. Installing Temurin JDK 17 via winget...
    winget install EclipseAdoptium.Temurin.17.JDK --accept-package-agreements --accept-source-agreements --silent
    echo.
    echo   ****************************************************************
    echo   *  Java was just installed. Windows needs a fresh window to    *
    echo   *  see it. Please CLOSE this window, open Command Prompt as     *
    echo   *  Administrator again, and re-run:  C:\deploy.bat              *
    echo   ****************************************************************
    echo.
    pause
    exit /b 0
)
echo       Java OK.

REM --- 4. Install the SuiteCloud CLI locally --------------------------
echo.
echo [3/5] Installing SuiteCloud CLI (this takes a minute)...
call npm install
if errorlevel 1 goto :fail

REM --- 5. Authenticate to NetSuite, then deploy ----------------------
echo.
echo [4/5] Connecting to NetSuite. A browser window will open.
echo       ^>^>^> LOG INTO YOUR SANDBOX and click Allow. ^<^<^<
echo.
call npx suitecloud account:setup
if errorlevel 1 goto :fail

echo.
echo [5/5] Deploying to your sandbox...
call npx suitecloud project:deploy
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo   DONE. Look above for "Installation COMPLETE".
echo   Tell Claude it finished and it will verify + seed a rule.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo ------------------------------------------------------------
echo   Something stopped above. Copy the last 15-20 lines and
echo   paste them to Claude - do not retype, just copy/paste.
echo ------------------------------------------------------------
pause
exit /b 1
