; AEGIS Suite – Ergänzungen des Installationsprogramms (P13).
;
; Die Tauri-CLI bindet diese Datei in das NSIS-Skript ein (bundle.windows.nsis.installerHooks).
; Pfade in `File` sind relativ zum erzeugten Skript (target/release/nsis/x64/): `..\..\` ist
; target/release (Dienst, Prüfprozess, Tresor-Host aus `cargo build --release`), `..\..\..\..\`
; die Wurzel des Repos (gebaute Erweiterungen).
;
; Installiert wird nur, was der Nutzer mit dem Installationsprogramm gewählt hat. Beim
; Entfernen bleiben Quarantäne und Daten erhalten – gelöscht werden sie nur nach zwei
; ausdrücklichen Bestätigungen (bei stiller Deinstallation nie).

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "..\..\aegis-service.exe"
  File "..\..\aegis-scanworker.exe"
  File "..\..\aegis-vault-host.exe"
  File "..\..\..\..\extensions\vault\host\com.aegis.vault.json"
  SetOutPath "$INSTDIR\extensions\vault"
  File /r "..\..\..\..\extensions\vault\dist\*"
  SetOutPath "$INSTDIR\extensions\webshield"
  File /r "..\..\..\..\extensions\webshield\dist\*"
  SetOutPath "$INSTDIR"

  ; Schutzdienst anlegen und starten (Installation läuft mit Administratorrechten).
  DetailPrint "AEGIS-Schutzdienst wird eingerichtet …"
  nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" install'
  Pop $0
  StrCmp $0 "0" +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "Der AEGIS-Schutzdienst konnte nicht eingerichtet werden (Code $0). Die App zeigt das ehrlich an; ohne Dienst gibt es keine Prüfungen im Hintergrund." /SD IDOK

  ; Native Messaging: Tresor-Host für Chrome, Edge und Brave registrieren (nur unsere
  ; Erweiterung darf ihn starten – allowed_origins im Manifest).
  WriteRegStr HKLM "Software\Google\Chrome\NativeMessagingHosts\com.aegis.vault" "" "$INSTDIR\com.aegis.vault.json"
  WriteRegStr HKLM "Software\Microsoft\Edge\NativeMessagingHosts\com.aegis.vault" "" "$INSTDIR\com.aegis.vault.json"
  WriteRegStr HKLM "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.aegis.vault" "" "$INSTDIR\com.aegis.vault.json"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Dienst anhalten und entfernen, Host-Registrierung löschen.
  DetailPrint "AEGIS-Schutzdienst wird entfernt …"
  nsExec::ExecToLog '"$INSTDIR\aegis-service.exe" uninstall'
  Pop $0
  DeleteRegKey HKLM "Software\Google\Chrome\NativeMessagingHosts\com.aegis.vault"
  DeleteRegKey HKLM "Software\Microsoft\Edge\NativeMessagingHosts\com.aegis.vault"
  DeleteRegKey HKLM "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.aegis.vault"
  Delete "$INSTDIR\aegis-service.exe"
  Delete "$INSTDIR\aegis-scanworker.exe"
  Delete "$INSTDIR\aegis-vault-host.exe"
  Delete "$INSTDIR\com.aegis.vault.json"
  RMDir /r "$INSTDIR\extensions"

  ; Daten des Dienstes (Quarantäne, Protokolle, Einstellungen) bleiben – außer der Nutzer
  ; bestätigt zweimal ausdrücklich. Still (/S): immer behalten.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Sollen auch die AEGIS-Daten gelöscht werden?$\r$\n$\r$\nDazu gehören die Quarantäne (isolierte Dateien), Protokolle und Einstellungen in $COMMONAPPDATA\AEGIS.$\r$\n$\r$\nStandard: Nein – die Daten bleiben erhalten." /SD IDNO IDYES aegis_ask_again
  Goto aegis_keep_data
  aegis_ask_again:
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Wirklich endgültig löschen?$\r$\n$\r$\nIsolierte Dateien in der Quarantäne lassen sich danach nicht mehr wiederherstellen." /SD IDNO IDYES aegis_delete_data
  Goto aegis_keep_data
  aegis_delete_data:
  RMDir /r "$COMMONAPPDATA\AEGIS"
  aegis_keep_data:
!macroend
