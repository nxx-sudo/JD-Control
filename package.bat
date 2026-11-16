@echo off
chcp 65001 >nul
title Empaquetar JD CONTROL
cd /d "%~dp0"

rem Carpeta lista para compartir: dist\JD CONTROL (+ dist\JD CONTROL.zip).
rem No incluye remote.json (legado), cert\ (clave privada de este PC),
rem cache\, logs\ ni backup\: cada PC genera los suyos.

set OUT=dist\JD CONTROL 0.1 BETA
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe

if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"

echo Compilando JD CONTROL.exe ...
"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 /out:"%OUT%\JD CONTROL.exe" ^
  /win32icon:jd.ico ^
  /win32manifest:app\app.manifest ^
  /reference:System.dll ^
  /reference:System.Windows.Forms.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Web.Extensions.dll ^
  app\MainForm.cs app\Lang.cs app\AssemblyInfo.cs
if errorlevel 1 goto :error

rem Huella del exe: quien reciba el zip puede comprobar que no se altero.
powershell -NoProfile -Command "$h=(Get-FileHash -LiteralPath '%OUT%\JD CONTROL.exe' -Algorithm SHA256).Hash.ToLower(); ($h + '  JD CONTROL.exe') | Set-Content -LiteralPath '%OUT%\SHA256.txt' -Encoding ascii"

for %%F in (server.js tunnel.js tunnel.bat start.bat package.json package-lock.json jd.ico cloudflared.exe README.md) do (
  if exist "%%F" copy /y "%%F" "%OUT%\" >nul
)
robocopy src "%OUT%\src" /e /njh /njs /nfl /ndl >nul
robocopy public "%OUT%\public" /e /njh /njs /nfl /ndl >nul
robocopy node_modules "%OUT%\node_modules" /e /njh /njs /nfl /ndl >nul

rem Node portable: el amigo no necesita instalar nada.
for /f "delims=" %%N in ('where node 2^>nul') do (
  if not exist "%OUT%\runtime\node.exe" (
    mkdir "%OUT%\runtime" 2>nul
    copy /y "%%N" "%OUT%\runtime\node.exe" >nul
  )
)
if not exist "%OUT%\runtime\node.exe" echo AVISO: no se encontro node.exe; el paquete necesitara Node.js instalado.

echo Comprimiendo ...
if exist "dist\JD CONTROL 0.1 BETA.zip" del /q "dist\JD CONTROL 0.1 BETA.zip"
powershell -NoProfile -Command "Compress-Archive -Path '%OUT%' -DestinationPath '%OUT%.zip'"
if errorlevel 1 goto :error

echo.
echo Listo: %OUT%.zip
if not "%1"=="/q" pause
exit /b 0

:error
echo.
echo ERROR al empaquetar.
if not "%1"=="/q" pause
exit /b 1
