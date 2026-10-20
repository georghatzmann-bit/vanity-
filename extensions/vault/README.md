# extensions/vault – AEGIS Tresor (Browser-Erweiterung)

Manifest V3 für Edge und Chrome. Füllt Logins aus dem **entsperrten** AEGIS-Passwort-Tresor aus –
nur auf der Seite, zu der ein Eintrag gehört. Die Erweiterung speichert selbst nichts und hat nur
das Recht `nativeMessaging` (D-055).

## Ablauf

1. Fokus in ein Passwortfeld (oder den Benutzernamen davor) zeigt einen kleinen Knopf.
2. Klick auf den Knopf oder **Alt+↓** im Feld fragt AEGIS nach Logins für diese Seite.
3. Auswahl eines Logins füllt Benutzername und Passwort aus.

Das Popup (Symbol in der Leiste) listet dieselben Logins für den aktiven Tab.

## Verbindung

`background.ts` → `chrome.runtime.sendNativeMessage('com.aegis.vault')` →
`aegis-vault-host.exe` (`crates/vault-host`) → Pipe des eigenen Kontos → AEGIS-App
(`apps/desktop/src-tauri/src/vault.rs`). Die Adresse der Seite setzt immer der Hintergrund aus
dem Absender, nie die Webseite.

Einrichten (macht später das Setup, P13): `scripts/register-vault-host.ps1` trägt
`host/com.aegis.vault.json` unter HKCU für Edge und Chrome ein.

## Befehle

```bash
pnpm --filter @aegis/vault-extension build      # dist/
pnpm --filter @aegis/vault-extension test       # vitest
pnpm --filter @aegis/vault-extension test:e2e   # Chromium mit harmlosem Test-Host
```
