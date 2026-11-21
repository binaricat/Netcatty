!macro customInit
  ; #3946: external MCP hosts launch Netcatty.exe with ELECTRON_RUN_AS_NODE=1
  ; via netcatty-external-mcp.cmd. Those processes can outlive the host UI as
  ; orphans and keep $INSTDIR locked, so the in-app updater hangs (AppHangB1).
  ; Force-kill leftover Netcatty.exe before files are replaced. Do not pass /T:
  ; electron-updater spawns this installer as a child of the UI Netcatty.exe,
  ; and /T would terminate the installer itself. Ignore a missing process.
  nsExec::ExecToLog "taskkill /F /IM Netcatty.exe"
  Pop $0
!macroend

!macro customInstall
  ; Open a selected folder in a new Netcatty local terminal.
  ; Args go after `--` so Electron/Chromium does not swallow them. Use
  ; `--open-terminal-path="%1."` so paths with spaces stay one token and drive
  ; roots (`C:\`) do not break Windows quote parsing.
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Netcatty" "MUIVerb" "Open in Netcatty"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Netcatty" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Netcatty\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- --open-terminal-path="%1."'

  ; Open the directory currently displayed by Explorer.
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Netcatty" "MUIVerb" "Open in Netcatty"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Netcatty" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Netcatty\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- --open-terminal-path="%V."'

  ; #4204: Windows Default Apps requires Capabilities/RegisteredApplications
  ; to list URL handlers; Electron's bare scheme keys are not sufficient.
  WriteRegStr SHCTX "Software\Classes\Netcatty.SSH" "" "URL:ssh Protocol"
  WriteRegStr SHCTX "Software\Classes\Netcatty.SSH" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Netcatty.SSH\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Netcatty.SSH\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Classes\Netcatty.Telnet" "" "URL:telnet Protocol"
  WriteRegStr SHCTX "Software\Classes\Netcatty.Telnet" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Netcatty.Telnet\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Netcatty.Telnet\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Classes\Netcatty.JMS" "" "URL:jms Protocol"
  WriteRegStr SHCTX "Software\Classes\Netcatty.JMS" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Netcatty.JMS\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Netcatty.JMS\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Netcatty\Capabilities" "ApplicationName" "Netcatty"
  WriteRegStr SHCTX "Software\Netcatty\Capabilities" "ApplicationDescription" "Open SSH, Telnet and JMS links in Netcatty."
  WriteRegStr SHCTX "Software\Netcatty\Capabilities" "ApplicationIcon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Netcatty\Capabilities\URLAssociations" "ssh" "Netcatty.SSH"
  WriteRegStr SHCTX "Software\Netcatty\Capabilities\URLAssociations" "telnet" "Netcatty.Telnet"
  WriteRegStr SHCTX "Software\Netcatty\Capabilities\URLAssociations" "jms" "Netcatty.JMS"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Netcatty" "Software\Netcatty\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Netcatty"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Netcatty"
  DeleteRegKey SHCTX "Software\Classes\Netcatty.SSH"
  DeleteRegKey SHCTX "Software\Classes\Netcatty.Telnet"
  DeleteRegKey SHCTX "Software\Classes\Netcatty.JMS"
  DeleteRegKey SHCTX "Software\Netcatty\Capabilities"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Netcatty"
!macroend
