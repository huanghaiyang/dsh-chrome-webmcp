@echo off
setlocal
title dsh-chrome-webmcp installer
rem Double-clickable wrapper for install.mjs. Forwards every argument; keeps the
rem window open when double-clicked (no arguments) or when the install failed.
set "HERE=%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%HERE%install.mjs" %*
set "CODE=%ERRORLEVEL%"

rem A non-zero exit always pauses; a bare double-click pauses too, a CLI call does not.
if not "%~1"=="" if "%CODE%"=="0" goto :done
echo.
pause

:done
exit /b %CODE%

:no_node
echo [install] Node.js 22 or newer is required, but "node" was not found on PATH.
echo [install] Install it from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1
