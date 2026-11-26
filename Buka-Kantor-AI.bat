@echo off
title Kantor AI Launcher
cd /d "%~dp0"

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if errorlevel 1 (
    start /min "Kantor AI Server" cmd /k "node sprint3-server.js"
    timeout /t 2 /nobreak >nul
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3000
) else (
    start "" "http://localhost:3000"
)