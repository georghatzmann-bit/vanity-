; Zusatz für den Deinstaller: Hat der Konto-Retter die Windows-Benachrichtigungen von Discord
; ausgeschaltet, werden sie bei der Deinstallation wieder eingeschaltet.
; (Bei einem Update läuft der alte Deinstaller auch – dann nichts verändern.)

!macro KR_RestoreDiscordToast ID
  ReadRegDWORD $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\${ID}" "Enabled"
  ${If} $1 == "0"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\${ID}" "Enabled"
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegDWORD $0 HKCU "Software\Konto-Retter" "DiscordToastsMuted"
    ${If} $0 == "1"
      !insertmacro KR_RestoreDiscordToast "com.squirrel.Discord.Discord"
      !insertmacro KR_RestoreDiscordToast "com.squirrel.DiscordPTB.DiscordPTB"
      !insertmacro KR_RestoreDiscordToast "com.squirrel.DiscordCanary.DiscordCanary"
    ${EndIf}
    DeleteRegKey HKCU "Software\Konto-Retter"
  ${EndIf}
!macroend
