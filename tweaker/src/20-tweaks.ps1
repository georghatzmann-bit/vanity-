# ------------------------------------------------------------------ Tweaks (Gratis-Version)
# Felder: Id, Name, Effect (ehrlich: was bringt es wirklich?), Category (Gaming/Netzwerk),
#         Recommended (fuer "Empfohlene Einstellungen"), Restart, Registry oder Capture/Apply/Revert/Test, After

$script:BalancedScheme = '381b4222-f694-41f0-9685-ff5bb260df2e'
$script:UltimateScheme = 'e9a42b02-d5df-448d-aa00-03f14749eb61'
$script:HighScheme     = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$script:OwnSchemeName  = 'TweakWerk Gaming'
$script:GuidPattern    = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

function Get-TWActivePowerScheme {
    $out = (powercfg /getactivescheme) -join ' '
    if ($out -match $script:GuidPattern) { return $Matches[0].ToLower() }
    return $null
}

function Get-TWOwnPowerScheme {
    foreach ($line in (powercfg /list)) {
        if ($line -match "($($script:GuidPattern))\s+\((.+?)\)" -and $Matches[2] -eq $script:OwnSchemeName) {
            return $Matches[1].ToLower()
        }
    }
    return $null
}

function New-TWOwnPowerScheme {
    # "Ultimative Leistung" kopieren, sonst "Hoechstleistung". Manche Laptops (Modern Standby) koennen beides nicht.
    foreach ($template in @($script:UltimateScheme, $script:HighScheme)) {
        $out = (powercfg /duplicatescheme $template 2>&1) -join ' '
        if ($LASTEXITCODE -eq 0 -and $out -match $script:GuidPattern) {
            $guid = $Matches[0].ToLower()
            powercfg /changename $guid $script:OwnSchemeName 'Erstellt von TweakWerk' | Out-Null
            return $guid
        }
    }
    throw 'Dein PC bietet keinen Höchstleistungs-Energieplan an (typisch für Laptops mit Modern Standby). Nutze dort den Windows-Energiemodus "Beste Leistung".'
}

function Test-TWIsLaptop {
    return [bool](Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)
}

function Update-TWMouseSettings {
    # Neue Mauswerte sofort anwenden, ohne Abmelden (SPI_SETMOUSE)
    if (-not ('TweakWerk.Native' -as [type])) {
        Add-Type -Namespace TweakWerk -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, int[] pvParam, uint fWinIni);
'@
    }
    $path = 'HKCU:\Control Panel\Mouse'
    $values = [int[]]@(
        [int](Get-TWRegValue -Path $path -Name 'MouseThreshold1').Value,
        [int](Get-TWRegValue -Path $path -Name 'MouseThreshold2').Value,
        [int](Get-TWRegValue -Path $path -Name 'MouseSpeed').Value
    )
    [void][TweakWerk.Native]::SystemParametersInfo(0x0004, 0, $values, 0x03)
}

$script:Tweaks = @(
    @{
        Id          = 'PowerPlan'
        Name        = 'Energieplan „Ultimative Leistung“'
        Effect      = 'Die CPU taktet nicht mehr ständig herunter. Das bringt stabilere FPS und weniger kurze Ruckler, vor allem in CPU-lastigen Spielen. Auf Laptops: mehr Akkuverbrauch und Wärme.'
        Category    = 'Gaming'
        Recommended = $true
        NotOnLaptop = $true   # bei "Empfohlene Einstellungen" auf Laptops auslassen (Akku)
        Capture     = { [pscustomobject]@{ PreviousGuid = Get-TWActivePowerScheme } }
        Apply       = {
            $guid = Get-TWOwnPowerScheme
            if (-not $guid) { $guid = New-TWOwnPowerScheme }
            powercfg /setactive $guid | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Energieplan konnte nicht aktiviert werden.' }
        }
        Revert      = {
            param($Saved)
            $previous = $script:BalancedScheme
            if ($Saved -and $Saved.PreviousGuid) { $previous = $Saved.PreviousGuid }
            powercfg /setactive $previous | Out-Null
            if ($LASTEXITCODE -ne 0) { powercfg /setactive $script:BalancedScheme | Out-Null }
            $own = Get-TWOwnPowerScheme
            if ($own -and $own -ne (Get-TWActivePowerScheme)) { powercfg /delete $own | Out-Null }
        }
        Test        = {
            $own = Get-TWOwnPowerScheme
            [bool]($own -and $own -eq (Get-TWActivePowerScheme))
        }
    }
    @{
        Id          = 'GameMode'
        Name        = 'Windows-Spielmodus'
        Effect      = 'Windows gibt dem laufenden Spiel Vorrang und verschiebt Update-Installationen und Hintergrundaufgaben. Bei Windows 11 meist schon an. Dann zeigt der Schalter das einfach an.'
        Category    = 'Gaming'
        Recommended = $true
        Registry    = @(
            @{ Path = 'HKCU:\Software\Microsoft\GameBar'; Name = 'AutoGameModeEnabled'; Type = 'DWord'; On = 1; Off = 0; Missing = 1 }
            @{ Path = 'HKCU:\Software\Microsoft\GameBar'; Name = 'AllowAutoGameMode'; Type = 'DWord'; On = 1; Off = 0; Missing = 1 }
        )
    }
    @{
        Id          = 'GameDVR'
        Name        = 'Xbox-Aufnahme im Hintergrund aus'
        Effect      = 'Windows zeichnet nicht mehr nebenbei dein Gameplay auf. Das spart Leistung, vor allem auf schwächeren PCs. Danach funktioniert Win+Alt+R (Clip aufnehmen) nicht mehr. Für Clips nimm OBS, Nvidia oder AMD.'
        Category    = 'Gaming'
        Recommended = $true
        Registry    = @(
            @{ Path = 'HKCU:\System\GameConfigStore'; Name = 'GameDVR_Enabled'; Type = 'DWord'; On = 0; Off = 1 }
            @{ Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR'; Name = 'AppCaptureEnabled'; Type = 'DWord'; On = 0; Off = 1 }
            @{ Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR'; Name = 'HistoricalCaptureEnabled'; Type = 'DWord'; On = 0; Off = $null }
        )
    }
    @{
        Id          = 'MouseAccel'
        Name        = 'Mausbeschleunigung aus'
        Effect      = 'Gleiche Handbewegung = gleiche Strecke auf dem Bildschirm, egal wie schnell du die Maus bewegst. Hilft beim Zielen in Shootern. Fühlt sich die ersten Tage ungewohnt an.'
        Category    = 'Gaming'
        Recommended = $false
        Registry    = @(
            @{ Path = 'HKCU:\Control Panel\Mouse'; Name = 'MouseSpeed'; Type = 'String'; On = '0'; Off = '1' }
            @{ Path = 'HKCU:\Control Panel\Mouse'; Name = 'MouseThreshold1'; Type = 'String'; On = '0'; Off = '6' }
            @{ Path = 'HKCU:\Control Panel\Mouse'; Name = 'MouseThreshold2'; Type = 'String'; On = '0'; Off = '10' }
        )
        After       = { Update-TWMouseSettings }
    }
)

# Vorschau der Pro-Funktionen fuer die Gratis-Version (nur Texte, kein Code)
$script:ProTeasers = @(
    @{ Id = 'HAGS'; Category = 'Gaming'; Name = 'Hardware-beschleunigte GPU-Planung'; Effect = 'Kann Input-Lag senken und ist Pflicht für DLSS Frame Generation.' }
    @{ Id = 'DeliveryOpt'; Category = 'Netzwerk'; Name = 'Update-Upload an fremde PCs aus'; Effect = 'Windows verteilt keine Updates mehr über deine Leitung an andere PCs.' }
    @{ Id = 'DnsCloudflare'; Category = 'Netzwerk'; Name = 'Schneller DNS (Cloudflare 1.1.1.1)'; Effect = 'Launcher und Webseiten finden ihre Server schneller.' }
)
