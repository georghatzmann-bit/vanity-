# Tests fuer TweakWerk. Laufen auch ohne Windows: Die Registry wird durch eine Attrappe im Speicher ersetzt.
# Aufruf:  pwsh -c "Invoke-Pester ./tests"

Describe 'TweakWerk' {
    BeforeAll {
        $src = Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
        . (Join-Path $src '10-core.ps1')
        . (Join-Path $src '20-tweaks.ps1')
        . (Join-Path $src '30-tools.ps1')
        . (Join-Path $src 'pro/40-pro-tweaks.ps1')
        . (Join-Path $src 'pro/41-startup.ps1')

        # --- Attrappen ---
        function Get-TWRegValue {
            param($Path, $Name)
            $k = "$Path|$Name".ToLower()
            if ($script:FakeReg.ContainsKey($k)) { return $script:FakeReg[$k] }
            return $null
        }
        function Set-TWRegValue {
            param($Path, $Name, $Type, $Value)
            if ($Type -eq 'Binary') { $Value = [byte[]]$Value }
            $script:FakeReg["$Path|$Name".ToLower()] = [pscustomobject]@{ Type = $Type; Value = $Value; Path = $Path; Name = $Name }
        }
        function Remove-TWRegValue {
            param($Path, $Name)
            $script:FakeReg.Remove("$Path|$Name".ToLower())
        }
        function Get-TWRegValueNames {
            param($Path)
            @($script:FakeReg.Values | Where-Object { $_.Path -eq $Path } | ForEach-Object { $_.Name })
        }
        function Write-TWLog { param($Message, $Level) }
        function Update-TWMouseSettings { $script:MouseUpdates++ }

        function Get-Tweak([string]$Id) { $script:Tweaks | Where-Object { $_.Id -eq $Id } | Select-Object -First 1 }
        function Reg([string]$Path, [string]$Name) { (Get-TWRegValue $Path $Name) }
    }

    BeforeEach {
        $script:FakeReg = @{}
        $script:MouseUpdates = 0
        $script:BackupFile = Join-Path $TestDrive ("backup-{0}.json" -f [guid]::NewGuid())
    }

    Describe 'Tweak-Definitionen' {
        It 'hat eindeutige Ids' {
            $ids = $script:Tweaks | ForEach-Object { $_.Id }
            ($ids | Select-Object -Unique).Count | Should -Be $ids.Count
        }

        It 'jeder Tweak hat Name, ehrliche Beschreibung und Kategorie' {
            foreach ($t in $script:Tweaks) {
                $t.Name | Should -Not -BeNullOrEmpty
                $t.Effect.Length | Should -BeGreaterThan 40 -Because "$($t.Id) braucht eine echte Erklärung"
                $t.Category | Should -BeIn @('Gaming', 'Netzwerk')
            }
        }

        It 'jeder Tweak ist vollständig (Registry-Einträge oder Apply/Revert/Test)' {
            foreach ($t in $script:Tweaks) {
                if ($t.Registry) {
                    foreach ($r in $t.Registry) {
                        $r.Path | Should -Match '^HK(CU|LM):\\'
                        $r.Name | Should -Not -BeNullOrEmpty
                        $r.Type | Should -BeIn @('DWord', 'String')
                        $r.On | Should -Not -BeNullOrEmpty -Because "$($t.Id)/$($r.Name) braucht einen Zielwert"
                        $r.Keys | Should -Contain 'Off' -Because "$($t.Id)/$($r.Name) braucht einen Aus-Zustand"
                    }
                } else {
                    $t.Apply | Should -BeOfType [scriptblock]
                    $t.Revert | Should -BeOfType [scriptblock]
                    $t.Test | Should -BeOfType [scriptblock]
                }
            }
        }

        It 'jede Pro-Vorschau gehört zu einem echten Pro-Tweak' {
            foreach ($teaser in $script:ProTeasers) {
                $t = Get-Tweak $teaser.Id
                $t | Should -Not -BeNullOrEmpty -Because "Vorschau $($teaser.Id) ohne Tweak"
                $t.Pro | Should -BeTrue
                $teaser.Category | Should -Be $t.Category
            }
        }

        It 'enthält keine Tweaks, die Sicherheit oder Updates abschalten' {
            $all = ($script:Tweaks | ForEach-Object { $_.Registry } | ForEach-Object { "$($_.Path)\$($_.Name)" }) -join "`n"
            $all | Should -Not -Match 'Defender|Firewall|WindowsUpdate\\AU|NoAutoUpdate|EnableLUA|SpyNet'
        }
    }

    Describe 'Registry-Engine' {
        It 'Anwenden setzt die Zielwerte und sichert "existierte nicht"' {
            $t = Get-Tweak 'GameDVR'
            Invoke-TWTweak -Tweak $t -Action Apply
            (Reg 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled').Value | Should -Be 0
            Test-TWTweak $t | Should -BeTrue
            $backup = Get-TWBackup
            $backup.ContainsKey('GameDVR') | Should -BeTrue
            @($backup['GameDVR']).Count | Should -Be 3
            @($backup['GameDVR'])[0].Existed | Should -BeFalse
        }

        It 'Rückgängig stellt vorhandene Originalwerte exakt wieder her' {
            Set-TWRegValue 'HKCU:\Control Panel\Mouse' 'MouseSpeed' 'String' '2'
            Set-TWRegValue 'HKCU:\Control Panel\Mouse' 'MouseThreshold1' 'String' '4'
            Set-TWRegValue 'HKCU:\Control Panel\Mouse' 'MouseThreshold2' 'String' '12'
            $t = Get-Tweak 'MouseAccel'
            Invoke-TWTweak -Tweak $t -Action Apply
            (Reg 'HKCU:\Control Panel\Mouse' 'MouseSpeed').Value | Should -Be '0'
            Invoke-TWTweak -Tweak $t -Action Revert
            (Reg 'HKCU:\Control Panel\Mouse' 'MouseSpeed').Value | Should -Be '2'
            (Reg 'HKCU:\Control Panel\Mouse' 'MouseThreshold1').Value | Should -Be '4'
            (Reg 'HKCU:\Control Panel\Mouse' 'MouseThreshold2').Value | Should -Be '12'
            (Reg 'HKCU:\Control Panel\Mouse' 'MouseSpeed').Type | Should -Be 'String'
            (Get-TWBackup).ContainsKey('MouseAccel') | Should -BeFalse
            $script:MouseUpdates | Should -Be 2 -Because 'Mauswerte müssen nach Anwenden UND Rückgängig sofort übernommen werden'
        }

        It 'Rückgängig löscht Werte, die vorher nicht existierten' {
            $t = Get-Tweak 'GameDVR'
            Invoke-TWTweak -Tweak $t -Action Apply
            Invoke-TWTweak -Tweak $t -Action Revert
            $script:FakeReg.Count | Should -Be 0
        }

        It 'zweimal Anwenden überschreibt das Original-Backup nicht' {
            Set-TWRegValue 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled' 'DWord' 0
            $t = Get-Tweak 'GameMode'
            Invoke-TWTweak -Tweak $t -Action Apply
            Invoke-TWTweak -Tweak $t -Action Apply
            $saved = @((Get-TWBackup)['GameMode']) | Where-Object { $_.Name -eq 'AutoGameModeEnabled' }
            $saved.Existed | Should -BeTrue
            $saved.Value | Should -Be 0
        }

        It 'Rückgängig ohne Backup setzt den Aus-Zustand (Off-Wert)' {
            Set-TWRegValue 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled' 'DWord' 1
            Set-TWRegValue 'HKCU:\Software\Microsoft\GameBar' 'AllowAutoGameMode' 'DWord' 1
            $t = Get-Tweak 'GameMode'
            Test-TWTweak $t | Should -BeTrue
            Invoke-TWTweak -Tweak $t -Action Revert
            (Reg 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled').Value | Should -Be 0
            Test-TWTweak $t | Should -BeFalse
        }

        It 'Spielmodus gilt als an, wenn Windows nichts eingetragen hat (Windows-Standard)' {
            Test-TWTweak (Get-Tweak 'GameMode') | Should -BeTrue
            Test-TWTweak (Get-Tweak 'GameDVR') | Should -BeFalse -Because 'ohne Missing-Angabe zählt ein fehlender Wert als nicht aktiv'
        }

        It 'Rückgängig ohne Backup löscht, wenn Off = $null (Policy-Werte)' {
            Set-TWRegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' 'DODownloadMode' 'DWord' 0
            Invoke-TWTweak -Tweak (Get-Tweak 'DeliveryOpt') -Action Revert
            Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' 'DODownloadMode' | Should -BeNullOrEmpty
        }

        It 'eigene Tweaks bekommen ihre Sicherung nach dem Speichern zurück' {
            $script:Seen = $null
            $custom = @{
                Id = 'Custom'; Name = 'Test'
                Capture = { [pscustomobject]@{ PreviousGuid = 'abc-123' } }
                Apply = { $script:Applied = $true }
                Revert = { param($Saved) $script:Seen = $Saved }
                Test = { $true }
            }
            Invoke-TWTweak -Tweak $custom -Action Apply
            Invoke-TWTweak -Tweak $custom -Action Revert
            $script:Seen.PreviousGuid | Should -Be 'abc-123'
            (Get-TWBackup).ContainsKey('Custom') | Should -BeFalse
        }

        It 'Undo-TWAll setzt alles zurück, auch Einträge ohne passende Definition' {
            Invoke-TWTweak -Tweak (Get-Tweak 'GameDVR') -Action Apply
            Invoke-TWTweak -Tweak (Get-Tweak 'HAGS') -Action Apply
            # Verwaister Eintrag (z. B. Pro-Tweak, aber Gratis-Version laeuft)
            $backup = Get-TWBackup
            $backup['Verwaist'] = @([pscustomobject]@{ Path = 'HKCU:\Test'; Name = 'X'; Existed = $false; Type = 'DWord'; Value = $null })
            Save-TWBackup $backup
            Set-TWRegValue 'HKCU:\Test' 'X' 'DWord' 5

            Undo-TWAll | Should -Be 0
            $script:FakeReg.Count | Should -Be 0
            (Get-TWBackup).Count | Should -Be 0
        }
    }

    Describe 'Sicherungsdatei' {
        It 'übersteht Binär-, Zahlen- und Textwerte beim Speichern und Laden' {
            Set-TWRegValue 'HKCU:\A' 'Bin' 'Binary' ([byte[]](3, 0, 0, 0, 255))
            Set-TWRegValue 'HKCU:\A' 'Num' 'DWord' 42
            Set-TWRegValue 'HKCU:\A' 'Txt' 'String' 'Hallo Ä'
            $t = @{ Id = 'Mix'; Name = 'Mix'; Registry = @(
                    @{ Path = 'HKCU:\A'; Name = 'Bin'; Type = 'Binary'; On = [byte[]](2, 0); Off = $null }
                    @{ Path = 'HKCU:\A'; Name = 'Num'; Type = 'DWord'; On = 1; Off = 0 }
                    @{ Path = 'HKCU:\A'; Name = 'Txt'; Type = 'String'; On = 'neu'; Off = '' }
                )
            }
            Invoke-TWTweak -Tweak $t -Action Apply
            Invoke-TWTweak -Tweak $t -Action Revert
            ((Reg 'HKCU:\A' 'Bin').Value -join ',') | Should -Be '3,0,0,0,255'
            (Reg 'HKCU:\A' 'Num').Value | Should -Be 42
            (Reg 'HKCU:\A' 'Txt').Value | Should -Be 'Hallo Ä'
        }

        It 'liefert eine leere Sicherung, wenn noch keine Datei existiert' {
            (Get-TWBackup).Count | Should -Be 0
        }
    }

    Describe 'Autostart-Manager' {
        It 'erkennt an/aus wie der Task-Manager' -ForEach @(
            @{ Data = $null; Expected = $true }
            @{ Data = [byte[]](2, 0, 0, 0); Expected = $true }
            @{ Data = [byte[]](6, 0, 0, 0); Expected = $true }
            @{ Data = [byte[]](3, 0, 0, 0); Expected = $false }
            @{ Data = [byte[]](7, 0, 0, 0); Expected = $false }
        ) {
            Test-TWStartupEnabled $Data | Should -Be $Expected
        }

        It 'schreibt gültige StartupApproved-Daten' {
            $now = [datetime]::new(2026, 10, 24, 12, 0, 0, [DateTimeKind]::Utc)
            $on = New-TWStartupApprovedData -Enabled $true
            $off = New-TWStartupApprovedData -Enabled $false -Now $now
            $on.Length | Should -Be 12
            $on[0] | Should -Be 2
            $off[0] | Should -Be 3
            [BitConverter]::ToInt64($off, 4) | Should -Be $now.ToFileTimeUtc()
            Test-TWStartupEnabled $off | Should -BeFalse
            Test-TWStartupEnabled $on | Should -BeTrue
        }

        It 'listet Einträge mit Zustand und schaltet sie um' {
            Set-TWRegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'Discord' 'String' 'C:\Discord\Update.exe'
            Set-TWRegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'Steam' 'String' 'C:\Steam\steam.exe -silent'
            Set-TWRegValue "HKCU:\$script:ApprovedBase\Run" 'Steam' 'Binary' (New-TWStartupApprovedData -Enabled $false)

            $items = Get-TWStartupItems
            $items.Count | Should -Be 2
            ($items | Where-Object Name -eq 'Discord').Enabled | Should -BeTrue
            ($items | Where-Object Name -eq 'Steam').Enabled | Should -BeFalse

            Set-TWStartupItem -Item ($items | Where-Object Name -eq 'Discord') -Enabled $false
            (Get-TWStartupItems | Where-Object Name -eq 'Discord').Enabled | Should -BeFalse
            # Der eigentliche Autostart-Eintrag bleibt unangetastet
            (Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'Discord').Value | Should -Be 'C:\Discord\Update.exe'
        }
    }

    Describe 'Spiel-Profile (GPU)' {
        It 'fügt ein Spiel hinzu und entfernt es wieder' {
            Add-TWGpuPreference -ExePath 'C:\Spiele\Valorant [EU]\game.exe'
            Get-TWGpuPreferences | Should -Contain 'C:\Spiele\Valorant [EU]\game.exe'
            (Reg $script:GpuPrefPath 'C:\Spiele\Valorant [EU]\game.exe').Value | Should -Be 'GpuPreference=2;'
            Remove-TWGpuPreference -ExePath 'C:\Spiele\Valorant [EU]\game.exe'
            @(Get-TWGpuPreferences).Count | Should -Be 0
        }
    }

    Describe 'Ping-Statistik' {
        It 'berechnet Durchschnitt, Jitter und Verlust' {
            $r = Get-TWLatencyStats -Samples @(20, 22, 21, 25) -Lost 0
            $r.Avg | Should -Be 22
            $r.Min | Should -Be 20
            $r.Max | Should -Be 25
            $r.Jitter | Should -Be 2
            $r.LossPct | Should -Be 0
            $r.Rating | Should -Be 'Sehr gut'
        }

        It 'meldet Paketverlust' {
            (Get-TWLatencyStats -Samples @(40, 41, 39, 40) -Lost 1).LossPct | Should -Be 20
        }

        It 'meldet "Keine Verbindung" ohne Messwerte' {
            $r = Get-TWLatencyStats -Samples @() -Lost 6
            $r.Rating | Should -Be 'Keine Verbindung'
            $r.LossPct | Should -Be 100
        }

        It 'bewertet <Avg> ms als <Rating>' -ForEach @(
            @{ Avg = 15; Rating = 'Sehr gut' }
            @{ Avg = 45; Rating = 'Gut' }
            @{ Avg = 80; Rating = 'OK' }
            @{ Avg = 140; Rating = 'Hoch' }
        ) {
            (Get-TWLatencyStats -Samples @($Avg, $Avg) -Lost 0).Rating | Should -Be $Rating
        }
    }

    Describe 'Aufräumen' {
        It 'Sicherheitsnetz: <Path> -> <Ok>' -ForEach @(
            @{ Path = 'C:\Users\Max\AppData\Local\Temp'; Ok = $true }
            @{ Path = 'C:\Windows\Temp\'; Ok = $true }
            @{ Path = 'C:\Users\MAXMUS~1\AppData\Local\Temp'; Ok = $true }
            @{ Path = 'C:\'; Ok = $false }
            @{ Path = 'C:'; Ok = $false }
            @{ Path = 'C:\Users\Max'; Ok = $false }
            @{ Path = 'D:\Spiele'; Ok = $false }
            @{ Path = ''; Ok = $false }
        ) {
            Test-TWSafeTempDir $Path | Should -Be $Ok
        }

        It 'löscht nur alte Dateien und lässt neue liegen' {
            $temp = Join-Path $TestDrive 'Temp'
            New-Item -ItemType Directory -Path (Join-Path $temp 'sub') -Force | Out-Null
            $old = Join-Path $temp 'sub/alt.tmp'
            $new = Join-Path $temp 'neu.tmp'
            Set-Content -Path $old -Value ('x' * 2048)
            Set-Content -Path $new -Value 'y'
            (Get-Item $old).LastWriteTime = (Get-Date).AddDays(-3)
            Mock Get-TWTempTargets { @($temp) }

            $r = Clear-TWTemp
            Test-Path $old | Should -BeFalse
            Test-Path $new | Should -BeTrue
            Test-Path (Join-Path $temp 'sub') | Should -BeFalse -Because 'leere Unterordner werden entfernt'
            $r.Files | Should -Be 1
        }
    }

    Describe 'Oberfläche (XAML)' {
        BeforeAll {
            $srcDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
            $xamlText = Get-Content (Join-Path $srcDir '50-ui.xaml') -Raw
            $uiCode = Get-Content (Join-Path $srcDir '60-ui.ps1') -Raw
        }

        It 'ist gültiges XML' {
            { [xml]$xamlText } | Should -Not -Throw
        }

        It 'enthält jedes Element, das der Code anspricht' {
            $names = [regex]::Matches($xamlText, 'x:Name="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
            $used = [regex]::Matches($uiCode, "Get-TWControl '([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
            $used.Count | Should -BeGreaterThan 20
            foreach ($u in $used) { $names | Should -Contain $u -Because "Get-TWControl '$u'" }
        }

        It 'enthält jede Stilvorlage, die der Code benutzt' {
            $keys = [regex]::Matches($xamlText, 'x:Key="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
            $used = [regex]::Matches($uiCode, "FindResource\('([^']+)'\)") | ForEach-Object { $_.Groups[1].Value }
            $used += [regex]::Matches($uiCode, "-Style '([^']+)'") | ForEach-Object { $_.Groups[1].Value }
            foreach ($u in ($used | Select-Object -Unique)) { $keys | Should -Contain $u }
        }

        It 'hat keine Code-Behind-Attribute (XamlReader würde abstürzen)' {
            $xamlText | Should -Not -Match 'x:Class|\sClick="|\sChecked="|\sLoaded="'
        }
    }

    Describe 'Build' {
        BeforeAll {
            $root = Split-Path -Parent $PSScriptRoot
            & python3 (Join-Path $root 'build.py') | Out-Null
            $free = Join-Path $root 'dist/TweakWerk-Free/TweakWerk.ps1'
            $pro = Join-Path $root 'dist/TweakWerk-Pro/TweakWerk.ps1'
        }

        It '<Name> lässt sich fehlerfrei parsen' -ForEach @(@{ Name = 'Free' }, @{ Name = 'Pro' }) {
            $file = Join-Path $root "dist/TweakWerk-$Name/TweakWerk.ps1"
            $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$errors)
            $errors.Count | Should -Be 0
        }

        It 'speichert mit UTF-8-BOM und Windows-Zeilenenden (sonst kaputte Umlaute in PowerShell 5.1)' {
            foreach ($f in $free, $pro) {
                $bytes = [IO.File]::ReadAllBytes($f)
                ($bytes[0..2] -join ',') | Should -Be '239,187,191'
                [Text.Encoding]::UTF8.GetString($bytes) | Should -Match "`r`n"
            }
        }

        It 'die Gratis-Version enthält keinen Pro-Code' {
            $text = Get-Content $free -Raw
            $text | Should -Match "Edition\s+= 'Free'"
            $text | Should -Not -Match 'function Get-TWStartupItems|function Add-TWGpuPreference|Set-DnsClientServerAddress|HwSchMode'
        }

        It 'die Pro-Version enthält alle Pro-Funktionen' {
            $text = Get-Content $pro -Raw
            $text | Should -Match "Edition\s+= 'Pro'"
            $text | Should -Match 'function Get-TWStartupItems'
            $text | Should -Match 'function Add-TWGpuPreference'
            $text | Should -Not -Match '__EDITION__|__PRO_URL__'
        }
    }
}
