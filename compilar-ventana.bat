@echo off
chcp 65001 >nul
title Compilar ventana JD
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
    set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
)

echo Compilando JD CONTROL.exe ...
"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 /out:"JD CONTROL.exe" ^
  /win32icon:jd.ico ^
  /win32manifest:app\app.manifest ^
  /reference:System.dll ^
  /reference:System.Windows.Forms.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Web.Extensions.dll ^
  app\MainForm.cs app\Lang.cs app\AssemblyInfo.cs

if errorlevel 1 (
    echo.
    echo ERROR de compilacion.
    pause
    exit /b 1
)

echo Listo: JD CONTROL.exe
pause
