@echo off
:: sparkshell.cmd - Direction B batch wrapper for omcp hook dispatch on Windows.
:: Compensates for Copilot CLI pwsh dispatch limitations (upstream issue 2026-05).
::
:: Usage: sparkshell.cmd <event-name>
::   stdin  - JSON hook payload from Copilot CLI
::   stdout - hook result JSON from omcp
::   stderr - passthrough from omcp
::   exit   - exit code from omcp
::
:: Invariant 4 (valid events): caller must pass a valid event name from
:: COPILOT_VALID_EVENTS. omcp hook fire performs the gate check.

setlocal

set "OMCP_EVENT=%~1"

if "%OMCP_EVENT%"=="" (
  echo {"kind":"error","message":"sparkshell.cmd: no event name supplied"} 1>&2
  exit /b 1
)

:: Resolve the omcp.js path relative to this script's location.
set "OMCP_JS=%~dp0..\dist\cli\omcp.js"

:: Allow override via environment for non-standard layouts.
if defined OMCP_DIST_PATH set "OMCP_JS=%OMCP_DIST_PATH%"

node "%OMCP_JS%" hook fire "%OMCP_EVENT%" --json
exit /b %ERRORLEVEL%
