; FreeMyDisk Custom Standalone NSIS Installer Script
; Features: Per-User Installation + Complete Uninstaller Self-Cleanup (Addendum B.4)

!include LogicLib.nsh

!define APP_NAME "FreeMyDisk"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "Foysal Zihak"
!define APP_EXE "FreeMyDisk.exe"

RequestExecutionLevel user ; Per-user install: no elevation required!

InstallDir "$LOCALAPPDATA\Programs\FreeMyDisk"
InstallDirRegKey HKCU "Software\FreeMyDisk" "InstallDir"

Name "${APP_NAME}"
OutFile "..\dist\FreeMyDisk-Setup-${APP_VERSION}.exe"

Section "Install"
    SetOutPath "$INSTDIR"
    File "/oname=FreeMyDisk.exe" "..\target\release\freemydisk.exe"
    File "..\target\release\freemydisk-elevated.exe"
    File "..\target\release\freemydisk-cli.exe"
    
    WriteUninstaller "$INSTDIR\uninstall.exe"
    
    ; Registry entries for Add/Remove Programs
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMyDisk" "DisplayName" "FreeMyDisk"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMyDisk" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMyDisk" "DisplayIcon" "$INSTDIR\FreeMyDisk.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMyDisk" "Publisher" "${APP_PUBLISHER}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMyDisk" "DisplayVersion" "${APP_VERSION}"
    
    ; Start menu shortcuts
    CreateDirectory "$SMPROGRAMS\FreeMyDisk"
    CreateShortcut "$SMPROGRAMS\FreeMyDisk\FreeMyDisk.lnk" "$INSTDIR\FreeMyDisk.exe"
    CreateShortcut "$SMPROGRAMS\FreeMyDisk\Uninstall FreeMyDisk.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
    ; 1. Terminate running helper processes
    nsExec::Exec 'taskkill /F /IM freemydisk-elevated.exe /T'
    nsExec::Exec 'taskkill /F /IM freemydisk-cli.exe /T'

    ; 2. Remove binary files and installation directory
    Delete "$INSTDIR\FreeMyDisk.exe"
    Delete "$INSTDIR\freemydisk.exe"
    Delete "$INSTDIR\freemydisk-elevated.exe"
    Delete "$INSTDIR\freemydisk-cli.exe"
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"
    
    ; 3. Remove shortcuts
    Delete "$SMPROGRAMS\FreeMyDisk\FreeMyDisk.lnk"
    Delete "$SMPROGRAMS\FreeMyDisk\Uninstall FreeMyDisk.lnk"
    RMDir "$SMPROGRAMS\FreeMyDisk"
    
    ; 4. Prompt user for complete self-cleanup (Addendum B.4)
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to remove all FreeMyDisk cleanup history, WAL journals, staging files, and crash reports?" IDNO skip_cleanup
    
    ; Remove AppData directory completely
    RMDir /r "$APPDATA\FreeMyDisk"
    RMDir /r "$LOCALAPPDATA\FreeMyDisk"
    
skip_cleanup:
    ; 5. Clean registry entries
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMyDisk"
    DeleteRegKey HKCU "Software\FreeMyDisk"
SectionEnd
