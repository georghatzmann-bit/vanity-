# TweakWerk - ehrlicher Gaming-Optimizer fuer Windows 10/11
# Jede Aenderung wird vorher gesichert und kann mit einem Klick rueckgaengig gemacht werden.
# Keine Placebo-Tweaks, kein Abschalten von Virenschutz oder Windows-Updates.
#
# Diese Datei wird von build.py aus den Teilen in src/ zusammengesetzt. Aendere die Teile, nicht das Ergebnis.

$script:AppName    = 'TweakWerk'
$script:AppVersion = '0.1.0-beta'
$script:Edition    = '__EDITION__'
$script:ProUrl     = '__PRO_URL__'
$script:DataDir    = Join-Path $env:LOCALAPPDATA $script:AppName
$script:BackupFile = Join-Path $script:DataDir 'backup.json'
$script:LogFile    = Join-Path $script:DataDir 'log.txt'
