@echo off
chcp 65001 >nul
title Just Dance - Sala local
cd /d "%~dp0"

set NODE=node
if exist "runtime\node.exe" set NODE="%~dp0runtime\node.exe"

if not exist node_modules (
    echo Instalando dependencias por primera vez...
    call npm install --no-audit --no-fund
)

start "" "http://localhost:8081/"
%NODE% server.js
pause
