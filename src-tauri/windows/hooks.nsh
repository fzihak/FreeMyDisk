; ==============================================================================
; FreeMyDisk Custom NSIS Hooks for Helper Binaries and Lifecycle Management
; ==============================================================================

!include LogicLib.nsh

!macro NSIS_HOOK_PREINSTALL
  ; Terminate any running helper instances prior to file updates
  nsExec::Exec 'taskkill /F /IM freemydisk-elevated.exe /T'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Ensure helper binaries are available directly in $INSTDIR alongside main binary
  ${If} ${FileExists} "$INSTDIR\resources\freemydisk-elevated.exe"
    CopyFiles /SILENT "$INSTDIR\resources\freemydisk-elevated.exe" "$INSTDIR\freemydisk-elevated.exe"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\freemydisk-cli.exe"
    CopyFiles /SILENT "$INSTDIR\resources\freemydisk-cli.exe" "$INSTDIR\freemydisk-cli.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Terminate any running helper instances prior to uninstallation
  nsExec::Exec 'taskkill /F /IM freemydisk-elevated.exe /T'
  nsExec::Exec 'taskkill /F /IM freemydisk-cli.exe /T'
  Delete "$INSTDIR\freemydisk-elevated.exe"
  Delete "$INSTDIR\freemydisk-cli.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; When DeleteAppData is selected or uninstallation completes, purge residual crash journals and logs
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\FreeMyDisk"
    RMDir /r "$LOCALAPPDATA\FreeMyDisk"
  ${EndIf}
!macroend
