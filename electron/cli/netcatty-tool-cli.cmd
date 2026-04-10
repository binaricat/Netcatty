@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "CLI_SCRIPT=%SCRIPT_DIR%netcatty-tool-cli.cjs"
set "APP_EXE="

if defined NETCATTY_CLI_ELECTRON_EXEC_PATH if exist "%NETCATTY_CLI_ELECTRON_EXEC_PATH%" set "APP_EXE=%NETCATTY_CLI_ELECTRON_EXEC_PATH%"
if not defined APP_EXE if exist "%SCRIPT_DIR%..\..\..\..\Netcatty.exe" set "APP_EXE=%SCRIPT_DIR%..\..\..\..\Netcatty.exe"
if not defined APP_EXE if exist "%SCRIPT_DIR%..\..\..\..\netcatty.exe" set "APP_EXE=%SCRIPT_DIR%..\..\..\..\netcatty.exe"

if defined APP_EXE (
  set "ELECTRON_RUN_AS_NODE=1"
  "%APP_EXE%" "%CLI_SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if not errorlevel 1 (
  node "%CLI_SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

echo Failed to locate the bundled Netcatty runtime for netcatty-tool-cli. 1>&2
exit /b 1
