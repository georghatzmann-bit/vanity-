# Schaltet die Töne von Discord stumm oder wieder an (Windows-Lautstärkemixer, pro Programm).
# Aufruf durch den Konto-Retter:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File DiscordAudio.ps1 -Action mute|unmute|query -CacheDir <Ordner>
# Ausgabe: eine Zeile pro Discord-Audiositzung: Gerät<TAB>PID<TAB>Prozess<TAB>stumm(0|1)<TAB>Ergebnis
# Exit-Code 2 = Discord hat gerade keine Audiositzung (noch keinen Ton abgespielt).

param(
    [ValidateSet('mute', 'unmute', 'query')]
    [string]$Action = 'query',
    [string]$CacheDir = ''
)

$ErrorActionPreference = 'Stop'
$typeName = 'KontoRetter.Audio.AppMuter'
$source = Join-Path $PSScriptRoot 'DiscordAudio.cs'

function Test-TypeLoaded {
    return [bool]($typeName -as [type])
}

# Einmal übersetzte DLL wiederverwenden, das spart bei jedem Klick 1-3 Sekunden.
if ($CacheDir) {
    $dll = Join-Path $CacheDir 'DiscordAudio-v1.dll'
    if (Test-Path -LiteralPath $dll) {
        try { Add-Type -Path $dll } catch { }
    }
    if (-not (Test-TypeLoaded)) {
        try {
            New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
            Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -Language CSharp -OutputAssembly $dll -OutputType Library
            Add-Type -Path $dll
        } catch { }
    }
}
if (-not (Test-TypeLoaded)) {
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -Language CSharp
}

$names = [string[]]@('Discord', 'DiscordPTB', 'DiscordCanary')
switch ($Action) {
    'mute' { $out = [KontoRetter.Audio.AppMuter]::Mute($names) }
    'unmute' { $out = [KontoRetter.Audio.AppMuter]::Unmute($names) }
    default { $out = [KontoRetter.Audio.AppMuter]::Query($names) }
}

if ([string]::IsNullOrEmpty($out)) {
    Write-Output 'NO_SESSION'
    exit 2
}
Write-Output $out
exit 0
