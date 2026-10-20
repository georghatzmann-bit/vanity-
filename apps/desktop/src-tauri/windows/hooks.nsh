; AEGIS Suite – Ergänzungen des Installationsprogramms (P13).
;
; Die Tauri-CLI bindet diese Datei in das NSIS-Skript ein (bundle.windows.nsis.installerHooks).
; Pfade in `File` sind relativ zum erzeugten Skript (target/release/nsis/x64/): `..\..\` ist
; target/release (Dienst, Prüfprozess, Labor-Sonde, Tresor-Host aus `cargo build --release`),
; `..\..\..\..\` die Wurzel des Repos (gebaute Erweiterungen).
;
; - Installiert wird nur nach „Programme“: Der Schutzdienst läuft als SYSTEM, sein Ordner darf
;   deshalb nur für Administratoren beschreibbar sein.
; - Updates (/UPDATE, still) ersetzen die Dateien, nachdem der Dienst angehalten wurde.
; - Beim Entfernen bleiben Quarantäne und Daten erhalten – gelöscht werden sie nur nach zwei
;   ausdrücklichen Bestätigungen (bei stiller Deinstallation und bei Updates nie). Das
;   Kästchen „App-Daten löschen“ der Vorlage ist abgeschaltet (es würde den Passwort-Tresor
;   mit einem einzigen Klick löschen).

!macro NSIS_HOOK_PREINSTALL
  ; Nur der feste Ordner unter „Programme“ (dort schreiben nur Administratoren).
  StrCmp $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}" aegis_dir_ok
    MessageBox MB_OK|MB_ICONSTOP "AEGIS wird immer nach $PROGRAMFILES64\${PRODUCTNAME} installiert – der Schutzdienst läuft als SYSTEM und braucht einen Ordner, in den nur Administratoren schreiben dürfen." /SD IDOK
    SetErrorLevel 2
    Abort
  aegis_dir_ok:
  ; Zuerst prüfen, ob die App läuft (die Vorlage fragt das sonst erst nach diesem Abschnitt).
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ; Update: laufenden Dienst anhalten und eigene Hilfsprogramme beenden, damit ihre Dateien
  ; ersetzt werden können.
  IfFileExists "$INSTDIR\aegis-service.exe" 0 aegis_no_service
    DetailPrint "AEGIS-Schutzdienst wird für das Update angehalten …"
    nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" stop'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM aegis-vault-host.exe'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM aegis-scanworker.exe'
    Pop $0
  aegis_no_service:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  ClearErrors
  File "..\..\aegis-service.exe"
  File "..\..\aegis-scanworker.exe"
  File "..\..\aegis-sandbox-probe.exe"
  File "..\..\aegis-vault-host.exe"
  File "..\..\..\..\extensions\vault\host\com.aegis.vault.json"
  SetOutPath "$INSTDIR\extensions\vault"
  File /r "..\..\..\..\extensions\vault\dist\*"
  SetOutPath "$INSTDIR\extensions\webshield"
  File /r "..\..\..\..\extensions\webshield\dist\*"
  SetOutPath "$INSTDIR"
  IfErrors 0 aegis_files_ok
    MessageBox MB_OK|MB_ICONSTOP "Dateien von AEGIS konnten nicht ersetzt werden (noch in Benutzung?). Bitte den Rechner neu starten und die Installation wiederholen." /SD IDOK
    SetErrorLevel 3
    Abort
  aegis_files_ok:

  ; Schutzdienst anlegen und starten (Installation läuft mit Administratorrechten). Der Dienst
  ; prüft selbst, dass er in einem geschützten Ordner liegt und wirklich läuft.
  DetailPrint "AEGIS-Schutzdienst wird eingerichtet …"
  nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" install'
  Pop $0
  StrCmp $0 "0" aegis_service_ok
    MessageBox MB_OK|MB_ICONEXCLAMATION "Der AEGIS-Schutzdienst konnte nicht eingerichtet werden (Code $0). Die App zeigt das ehrlich an; ohne Dienst gibt es keine Prüfungen im Hintergrund." /SD IDOK
    SetErrorLevel 3
  aegis_service_ok:

  ; Native Messaging: Tresor-Host für Chrome, Edge und Brave registrieren (nur unsere
  ; Erweiterung darf ihn starten – allowed_origins im Manifest).
  WriteRegStr HKLM "Software\Google\Chrome\NativeMessagingHosts\com.aegis.vault" "" "$INSTDIR\com.aegis.vault.json"
  WriteRegStr HKLM "Software\Microsoft\Edge\NativeMessagingHosts\com.aegis.vault" "" "$INSTDIR\com.aegis.vault.json"
  WriteRegStr HKLM "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.aegis.vault" "" "$INSTDIR\com.aegis.vault.json"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Kästchen „App-Daten löschen“ der Vorlage nie auswerten (Tresor!).
  StrCpy $DeleteAppDataCheckboxState 0
  ; Erst prüfen, ob die App läuft – bricht der Nutzer hier ab, bleibt der Dienst bestehen.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Daten des Dienstes (Quarantäne, Protokolle, Einstellungen) bleiben – außer der Nutzer
  ; bestätigt zweimal ausdrücklich. Still (/S) und bei Updates: immer behalten.
  ${If} $UpdateMode <> 1
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Sollen auch die AEGIS-Daten gelöscht werden?$\r$\n$\r$\nDazu gehören die Quarantäne (isolierte Dateien), Protokolle und Einstellungen in $COMMONAPPDATA\AEGIS. Dein Passwort-Tresor bleibt in jedem Fall erhalten.$\r$\n$\r$\nStandard: Nein – die Daten bleiben erhalten." /SD IDNO IDYES aegis_ask_again
    Goto aegis_keep_data
    aegis_ask_again:
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Wirklich endgültig löschen?$\r$\n$\r$\nIsolierte Dateien in der Quarantäne lassen sich danach nicht mehr wiederherstellen." /SD IDNO IDYES aegis_delete_data
    Goto aegis_keep_data
    aegis_delete_data:
    ; Der Dienst löscht seinen Ordner selbst, ohne Links oder Abzweigungen zu folgen.
    nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" stop'
    Pop $0
    nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" purge-data --confirmed-twice'
    Pop $0
    StrCmp $0 "0" aegis_keep_data
      MessageBox MB_OK|MB_ICONEXCLAMATION "Die AEGIS-Daten konnten nicht vollständig gelöscht werden (Code $0)." /SD IDOK
    aegis_keep_data:
  ${EndIf}

  ; Dienst anhalten und entfernen, Host-Registrierung und eigene Dateien löschen.
  DetailPrint "AEGIS-Schutzdienst wird entfernt …"
  nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" uninstall'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM aegis-vault-host.exe'
  Pop $0
  DeleteRegKey HKLM "Software\Google\Chrome\NativeMessagingHosts\com.aegis.vault"
  DeleteRegKey HKLM "Software\Microsoft\Edge\NativeMessagingHosts\com.aegis.vault"
  DeleteRegKey HKLM "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.aegis.vault"
  Delete "$INSTDIR\aegis-service.exe"
  Delete "$INSTDIR\aegis-scanworker.exe"
  Delete "$INSTDIR\aegis-sandbox-probe.exe"
  Delete "$INSTDIR\aegis-vault-host.exe"
  Delete "$INSTDIR\com.aegis.vault.json"
  RMDir /r "$INSTDIR\extensions"
!macroend
