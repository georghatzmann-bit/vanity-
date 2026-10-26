; Niobium installer hooks.
;
; Tauri's installer.nsi includes this file right after MUI2.nsh and before any page is declared,
; so the MUI look-and-feel settings below still apply. Colours come from docs/brand.md.
; Keep this file plain ASCII (NSIS reads included files without a BOM as ANSI).

!define NIOBIUM_HOOK_DIR "${__FILEDIR__}"

; ---------- Look & feel (dark, brand background #07070C) ----------
!define MUI_BGCOLOR "07070C"            ; header band + Welcome/Finish page background (edge colour of header.bmp)
!define MUI_TEXTCOLOR "F4F4F8"
!define MUI_FORCECLASSICCONTROLS        ; Finish-page checkboxes honour MUI_TEXTCOLOR (MUI2 bug #443)
!define MUI_HEADERIMAGE_RIGHT           ; logo on the right of the header band
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to $(^Name)"
!define MUI_WELCOMEPAGE_TEXT "Old seasons, new shine.$\r$\n$\r$\nThis installs $(^Name) on your PC. Play your own OG Fortnite builds with your friends - you bring the game files, $(^Name) does the rest.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_TITLE "You're ready to drop."
!define MUI_FINISHPAGE_TEXT "$(^Name) is installed.$\r$\n$\r$\nAdd a build folder in the Library and press Play. Have fun!"
!define MUI_FINISHPAGE_RUN_TEXT "Launch $(^Name) now"
!define MUI_FINISHPAGE_LINK "Source code and help (GitHub)"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/georghatzmann-bit/vanity-"
!define MUI_FINISHPAGE_LINK_COLOR "C4B5FD"

; Windows 11: dark title bar + caption colour #07070C (COLORREF 0x00BBGGRR). Fails harmlessly on Windows 10.
!macro NIOBIUM_DARK_TITLE_BAR
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x000C0707, i 4)'
!macroend

; ---------- Fading splash before the wizard (AdvSplash ships with NSIS) ----------
!define MUI_CUSTOMFUNCTION_GUIINIT NiobiumGuiInit
Function NiobiumGuiInit
  !insertmacro NIOBIUM_DARK_TITLE_BAR
  ; no splash for passive (/P) and update (/UPDATE) runs; silent runs never show a window
  ${GetOptions} $CMDLINE "/P" $0
  ${If} ${Errors}
    ${GetOptions} $CMDLINE "/UPDATE" $0
    ${If} ${Errors}
      InitPluginsDir
      File "/oname=$PLUGINSDIR\nbsplash.bmp" "${NIOBIUM_HOOK_DIR}\assets\splash.bmp"
      ; 900 ms visible, 350 ms fade in, 300 ms fade out, pure magenta is see-through
      advsplash::show 900 350 300 0xFF00FF "$PLUGINSDIR\nbsplash"
      Pop $0
    ${EndIf}
  ${EndIf}
FunctionEnd

!define MUI_CUSTOMFUNCTION_UNGUIINIT un.NiobiumGuiInit
Function un.NiobiumGuiInit
  !insertmacro NIOBIUM_DARK_TITLE_BAR
FunctionEnd

; ---------- Install hooks ----------
!macro NSIS_HOOK_PREINSTALL
  ; Niobium used to be called "Vanity". If the old Vanity launcher is installed (its uninstall entry
  ; exists), remove it quietly so it isn't installed twice. Its uninstaller only removes its own program
  ; files and shortcuts - never settings or server data (Niobium copies those over on its first start).
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vanity" "UninstallString"
  ${If} $R9 != ""
    ReadRegStr $R8 HKCU "Software\Georg Hatzmann\Vanity" ""
    ${If} $R8 == ""
      ; fall back to the uninstall entry: "C:\...\Vanity\uninstall.exe" -> C:\...\Vanity
      StrCpy $R8 $R9
      ${If} ${FileExists} "$R8"
        ${GetParent} "$R8" $R8
      ${Else}
        StrCpy $R8 $R8 "" 1
        StrCpy $R8 $R8 -1
        ${GetParent} "$R8" $R8
      ${EndIf}
    ${EndIf}
    ${If} $R8 != ""
    ${AndIf} $R8 != $INSTDIR
    ${AndIf} ${FileExists} "$R8\uninstall.exe"
      DetailPrint "Removing the old Vanity launcher..."
      ; /S = silent, _?= = run in place so ExecWait really waits
      ExecWait '"$R8\uninstall.exe" /S _?=$R8' $R7
      ; run in place, the uninstaller can't delete itself
      Delete "$R8\uninstall.exe"
      ; only removes the folder if it is empty (settings and logs stay)
      RMDir "$R8"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; jump straight from the progress bar to the Finish page (no extra "Next" click)
  SetAutoClose true
!macroend
