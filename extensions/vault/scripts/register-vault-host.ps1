# Registriert den Native-Messaging-Host „com.aegis.vault“ für Edge und Chrome – nur für das
# eigene Konto (HKCU), nur für die Erweiterung „AEGIS Tresor“ (allowed_origins im Manifest).
# Aufruf: powershell -NoProfile -File register-vault-host.ps1 -InstallDir "C:\Programme\AEGIS Suite"
# Das Setup (P13) erledigt das automatisch; zum Entfernen: -Remove.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$manifest = Join-Path $InstallDir 'com.aegis.vault.json'
$keys = @(
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.aegis.vault',
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.aegis.vault'
)
foreach ($key in $keys) {
  if ($Remove) {
    if (Test-Path $key) { Remove-Item -Path $key }
  } else {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifest
  }
}
