@echo off
chcp 65001 >nul
title JD CONTROL - Tunel publico
cd /d "%~dp0"

set NODE=node
if exist "runtime\node.exe" set NODE="%~dp0runtime\node.exe"

echo.
echo  Abriendo tunel publico hacia este PC (sin Render, sin abrir puertos).
echo  La primera vez descarga cloudflared.
echo.

%NODE% tunnel.js

echo.
echo  El tunel se cerro. Pulsa una tecla para salir.
pause >nul
