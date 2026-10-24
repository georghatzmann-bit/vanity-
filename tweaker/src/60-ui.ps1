# ------------------------------------------------------------------ Oberflaeche (WPF)
# Alles, was Event-Handler spaeter brauchen, liegt im Script-Scope ($script:...).

$script:TweakSwitches = @()
$script:SafetyAsked = $false
$script:SysInfo = $null

function Get-TWControl {
    param([string]$Name)
    $control = $script:Window.FindName($Name)
    if (-not $control) { throw "Oberflächen-Element '$Name' fehlt." }
    return $control
}

function ConvertTo-TWBrush {
    param([string]$Color)
    return (New-Object System.Windows.Media.BrushConverter).ConvertFromString($Color)
}

function New-TWTextBlock {
    param([string]$Text, [double]$Size = 13, [string]$Color = '#E6EDF3', [switch]$Bold, [switch]$Wrap)
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.FontSize = $Size
    $tb.Foreground = ConvertTo-TWBrush $Color
    if ($Bold) { $tb.FontWeight = [System.Windows.FontWeights]::SemiBold }
    if ($Wrap) { $tb.TextWrapping = [System.Windows.TextWrapping]::Wrap }
    return $tb
}

function New-TWBadge {
    param([string]$Text, [string]$Color, [string]$TextColor = '#0D1117')
    $badge = New-Object System.Windows.Controls.Border
    $badge.CornerRadius = New-Object System.Windows.CornerRadius 6
    $badge.Padding = New-Object System.Windows.Thickness 6, 1, 6, 1
    $badge.Margin = New-Object System.Windows.Thickness 8, 0, 0, 0
    $badge.VerticalAlignment = 'Center'
    $badge.Background = ConvertTo-TWBrush $Color
    $label = New-TWTextBlock -Text $Text -Size 10 -Color $TextColor
    $label.FontWeight = [System.Windows.FontWeights]::Bold
    $badge.Child = $label
    return $badge
}

function New-TWRow {
    # Karte mit Titel, Badges, Beschreibung links und einem Element (Schalter/Knopf) rechts
    param([string]$Title, [string]$Text, [object[]]$Badges = @(), $Right, [switch]$Dim)
    $card = New-Object System.Windows.Controls.Border
    $card.Style = $script:Window.FindResource('Card')
    $grid = New-Object System.Windows.Controls.Grid
    $c0 = New-Object System.Windows.Controls.ColumnDefinition
    $c0.Width = New-Object System.Windows.GridLength 1, 'Star'
    $c1 = New-Object System.Windows.Controls.ColumnDefinition
    $c1.Width = [System.Windows.GridLength]::Auto
    $grid.ColumnDefinitions.Add($c0)
    $grid.ColumnDefinitions.Add($c1)

    $left = New-Object System.Windows.Controls.StackPanel
    $head = New-Object System.Windows.Controls.StackPanel
    $head.Orientation = 'Horizontal'
    [void]$head.Children.Add((New-TWTextBlock -Text $Title -Size 15 -Bold))
    foreach ($b in $Badges) { [void]$head.Children.Add($b) }
    [void]$left.Children.Add($head)
    if ($Text) {
        $desc = New-TWTextBlock -Text $Text -Color '#8B949E' -Wrap
        $desc.Margin = New-Object System.Windows.Thickness 0, 6, 0, 0
        [void]$left.Children.Add($desc)
    }
    [System.Windows.Controls.Grid]::SetColumn($left, 0)
    [void]$grid.Children.Add($left)

    if ($Right) {
        $Right.VerticalAlignment = 'Center'
        $Right.Margin = New-Object System.Windows.Thickness 18, 0, 0, 0
        [System.Windows.Controls.Grid]::SetColumn($Right, 1)
        [void]$grid.Children.Add($Right)
    }
    if ($Dim) { $card.Opacity = 0.6 }
    $card.Child = $grid
    return $card
}

function New-TWSwitch {
    $cb = New-Object System.Windows.Controls.CheckBox
    $cb.Style = $script:Window.FindResource('Switch')
    return $cb
}

function New-TWButton {
    param([string]$Text, [string]$Style = 'BtnGhost')
    $btn = New-Object System.Windows.Controls.Button
    $btn.Content = $Text
    $btn.Style = $script:Window.FindResource($Style)
    $btn.Margin = New-Object System.Windows.Thickness 0
    return $btn
}

# --- Ablauf-Helfer ---------------------------------------------------------------------------

function Invoke-TWBusy {
    # Sperrt die Oberflaeche waehrend einer Aktion und zeigt den Warte-Cursor
    param([scriptblock]$Action)
    $tabs = Get-TWControl 'Tabs'
    $script:Window.Cursor = [System.Windows.Input.Cursors]::Wait
    $tabs.IsEnabled = $false
    Update-TWUi
    try { & $Action }
    finally {
        $tabs.IsEnabled = $true
        $script:Window.Cursor = $null
    }
}

function Show-TWMessage {
    param([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information')
    return [System.Windows.MessageBox]::Show($script:Window, $Text, $script:AppName, $Buttons, $Icon)
}

function Confirm-TWSafety {
    # Vor der ersten Aenderung einmal fragen, ob ein Wiederherstellungspunkt erstellt werden soll
    if ($script:RestorePointCreated -or $script:SafetyAsked) { return $true }
    $answer = Show-TWMessage -Text ("Bevor du etwas änderst: Soll ich einen Wiederherstellungspunkt erstellen?`n`n" +
        "Das ist dein Rettungsanker, falls irgendetwas schiefgeht. Dauert etwa eine Minute.") -Buttons 'YesNoCancel' -Icon 'Question'
    if ("$answer" -eq 'Cancel') { return $false }
    $script:SafetyAsked = $true
    if ("$answer" -eq 'Yes') {
        Write-TWLog 'Erstelle Wiederherstellungspunkt … (kann eine Minute dauern)'
        Invoke-TWBusy { [void](New-TWRestorePoint) }
        Update-TWStatus
    }
    return $true
}

function Update-TWStatus {
    $status = Get-TWControl 'RestoreStatus'
    if ($script:RestorePointCreated) { $status.Text = '✔ Wiederherstellungspunkt in dieser Sitzung erstellt.' }
    else { $status.Text = 'Noch kein Wiederherstellungspunkt in dieser Sitzung.' }
    $count = (Get-TWBackup).Count
    $info = Get-TWControl 'BackupInfo'
    if ($count -eq 0) { $info.Text = 'Aktuell sind keine TweakWerk-Änderungen aktiv.' }
    else { $info.Text = "Aktive Änderungen mit Sicherung: $count" }
}

function Sync-TWSwitches {
    foreach ($cb in $script:TweakSwitches) {
        try { $cb.IsChecked = Test-TWTweak $cb.Tag } catch { $cb.IsChecked = $false }
    }
    Update-TWStatus
}

function Open-TWProPage {
    if ($script:ProUrl -match '^https?://') { Start-Process $script:ProUrl }
    else { [void](Show-TWMessage 'Die Pro-Version ist bald verfügbar.') }
}

# --- Aktionen ---------------------------------------------------------------------------------

function Invoke-TWToggleFromUi {
    param($CheckBox)
    $tweak = $CheckBox.Tag
    $enable = [bool]$CheckBox.IsChecked
    if (-not (Confirm-TWSafety)) {
        $CheckBox.IsChecked = -not $enable
        return
    }
    $action = 'Revert'
    if ($enable) { $action = 'Apply' }
    Invoke-TWBusy {
        try {
            Invoke-TWTweak -Tweak $tweak -Action $action
            if ($enable) { Write-TWLog "$($tweak.Name): aktiviert" Ok } else { Write-TWLog "$($tweak.Name): zurückgesetzt" Ok }
            if ($tweak.Restart) { Write-TWLog 'Wird nach einem Neustart wirksam.' Warn }
        } catch {
            Write-TWLog "$($tweak.Name) fehlgeschlagen: $($_.Exception.Message)" Error
        }
    }
    try { $CheckBox.IsChecked = Test-TWTweak $tweak } catch { }
    Update-TWStatus
}

function Invoke-TWRecommended {
    if (-not (Confirm-TWSafety)) { return }
    $isLaptop = [bool]($script:SysInfo -and $script:SysInfo.Laptop)
    $script:RestartNeeded = $false   # im Script-Scope, weil der Block unten in einem eigenen Scope laeuft
    Invoke-TWBusy {
        foreach ($t in @($script:Tweaks | Where-Object { $_.Recommended })) {
            if ($t.NotOnLaptop -and $isLaptop) {
                Write-TWLog "$($t.Name): auf Laptops ausgelassen (Akku). Kannst du im Gaming-Bereich selbst einschalten."
                continue
            }
            try {
                if (Test-TWTweak $t) { Write-TWLog "$($t.Name): war schon aktiv" }
                else {
                    Invoke-TWTweak -Tweak $t -Action Apply
                    Write-TWLog "$($t.Name): aktiviert" Ok
                    if ($t.Restart) { $script:RestartNeeded = $true }
                }
            } catch { Write-TWLog "$($t.Name) fehlgeschlagen: $($_.Exception.Message)" Error }
        }
    }
    Sync-TWSwitches
    if ($script:RestartNeeded) { Write-TWLog 'Einige Änderungen werden erst nach einem Neustart wirksam.' Warn }
    Write-TWLog 'Fertig. Starte jetzt ein Spiel und vergleiche.' Ok
}

function Invoke-TWPingTest {
    $panel = Get-TWControl 'PingResults'
    $panel.Children.Clear()
    Invoke-TWBusy {
        foreach ($target in $script:PingTargets) {
            Write-TWLog "Messe $($target.Name) …"
            $r = Measure-TWLatency -HostName $target.Host
            [void]$panel.Children.Add((New-TWPingRow -Name $target.Name -Result $r))
            Update-TWUi
        }
    }
    Write-TWLog 'Ping-Test fertig.' Ok
}

function New-TWPingRow {
    param([string]$Name, $Result)
    $grid = New-Object System.Windows.Controls.Grid
    $grid.Margin = New-Object System.Windows.Thickness 0, 4, 0, 4
    foreach ($w in @(230, 90, 90, 110, 120)) {
        $col = New-Object System.Windows.Controls.ColumnDefinition
        $col.Width = New-Object System.Windows.GridLength $w
        $grid.ColumnDefinitions.Add($col)
    }
    $colors = @{ 'Sehr gut' = '#22C55E'; 'Gut' = '#2DD4BF'; 'OK' = '#E3B341'; 'Hoch' = '#F97316'; 'Keine Verbindung' = '#F85149' }
    $cells = @(
        (New-TWTextBlock -Text $Name -Bold),
        (New-TWTextBlock -Text $(if ($null -ne $Result.Avg) { "$($Result.Avg) ms" } else { '–' }) -Bold),
        (New-TWTextBlock -Text $(if ($null -ne $Result.Jitter) { "± $($Result.Jitter) ms" } else { '–' }) -Color '#8B949E'),
        (New-TWTextBlock -Text "$($Result.LossPct) % Verlust" -Color $(if ($Result.LossPct -gt 0) { '#F85149' } else { '#8B949E' })),
        (New-TWTextBlock -Text $Result.Rating -Bold -Color $colors[$Result.Rating])
    )
    for ($i = 0; $i -lt $cells.Count; $i++) {
        [System.Windows.Controls.Grid]::SetColumn($cells[$i], $i)
        [void]$grid.Children.Add($cells[$i])
    }
    return $grid
}

function Invoke-TWClean {
    $recycle = [bool](Get-TWControl 'ChkRecycle').IsChecked
    $script:CleanResultData = $null
    Invoke-TWBusy { $script:CleanResultData = Clear-TWTemp -RecycleBin:$recycle }
    $r = $script:CleanResultData
    $text = '{0:N1} MB freigegeben ({1} Dateien gelöscht).' -f $r.FreedMB, $r.Files
    if ($r.Skipped -gt 0) { $text += " $($r.Skipped) Dateien waren gerade in Benutzung und wurden übersprungen. Das ist normal." }
    (Get-TWControl 'CleanResult').Text = $text
    Write-TWLog $text Ok
}

function Invoke-TWUndoAll {
    $answer = Show-TWMessage -Text 'Alle Änderungen von TweakWerk rückgängig machen?' -Buttons 'YesNo' -Icon 'Question'
    if ("$answer" -ne 'Yes') { return }
    $script:UndoErrors = 0
    Invoke-TWBusy { $script:UndoErrors = Undo-TWAll }
    Sync-TWSwitches
    if ($script:UndoErrors -eq 0) { Write-TWLog 'Alles zurückgesetzt.' Ok }
    else { [void](Show-TWMessage "Fertig, aber $($script:UndoErrors) Punkt(e) konnten nicht zurückgesetzt werden. Details im Protokoll." 'OK' 'Warning') }
}

# --- Pro-Bereiche -----------------------------------------------------------------------------

function Show-TWGpuList {
    $list = Get-TWControl 'GpuList'
    $list.Children.Clear()
    $games = @(Get-TWGpuPreferences)
    if (-not $games) {
        [void]$list.Children.Add((New-TWTextBlock -Text 'Noch keine Spiele hinzugefügt.' -Color '#6E7681'))
        return
    }
    foreach ($path in $games) {
        $btn = New-TWButton -Text 'Entfernen'
        $btn.Tag = $path
        $btn.Add_Click({
                try { Remove-TWGpuPreference -ExePath $this.Tag } catch { Write-TWLog "Entfernen fehlgeschlagen: $($_.Exception.Message)" Error }
                Show-TWGpuList
            })
        $row = New-TWRow -Title (Split-Path -Leaf $path) -Text $path -Right $btn
        $row.Background = ConvertTo-TWBrush '#0D1117'
        [void]$list.Children.Add($row)
    }
}

function Add-TWGpuGameFromDialog {
    $dialog = New-Object Microsoft.Win32.OpenFileDialog
    $dialog.Title = 'Spiel auswählen (die .exe-Datei)'
    $dialog.Filter = 'Programme (*.exe)|*.exe'
    if ($dialog.ShowDialog($script:Window)) {
        try { Add-TWGpuPreference -ExePath $dialog.FileName } catch { Write-TWLog "Hinzufügen fehlgeschlagen: $($_.Exception.Message)" Error }
        Show-TWGpuList
    }
}

function Show-TWStartupList {
    $list = Get-TWControl 'StartupList'
    $list.Children.Clear()
    $items = @()
    try { $items = @(Get-TWStartupItems) } catch { Write-TWLog "Autostart-Liste konnte nicht gelesen werden: $($_.Exception.Message)" Error }
    if (-not $items) {
        [void]$list.Children.Add((New-TWTextBlock -Text 'Keine Autostart-Einträge gefunden.' -Color '#6E7681'))
        return
    }
    foreach ($item in $items) {
        $toggle = New-TWSwitch
        $toggle.IsChecked = $item.Enabled
        $toggle.Tag = $item
        $toggle.Add_Click({
                $entry = $this.Tag
                $want = [bool]$this.IsChecked
                try {
                    Set-TWStartupItem -Item $entry -Enabled $want
                    $entry.Enabled = $want
                } catch {
                    Write-TWLog "Autostart '$($entry.Name)' fehlgeschlagen: $($_.Exception.Message)" Error
                    $this.IsChecked = -not $want
                }
            })
        $command = $item.Command
        if ($command.Length -gt 110) { $command = $command.Substring(0, 107) + '…' }
        $row = New-TWRow -Title $item.Name -Text $command -Badges @(New-TWBadge -Text $item.Source -Color '#30363D' -TextColor '#C9D1D9') -Right $toggle
        $row.ToolTip = $item.Command
        [void]$list.Children.Add($row)
    }
    $off = @($items | Where-Object { -not $_.Enabled }).Count
    Write-TWLog "Autostart: $($items.Count) Einträge, davon $off ausgeschaltet."
}

# --- Fenster ----------------------------------------------------------------------------------

function Add-TWTweakRows {
    param([string]$Category, [string]$PanelName)
    $panel = Get-TWControl $PanelName
    foreach ($tweak in @($script:Tweaks | Where-Object { $_.Category -eq $Category })) {
        $badges = @()
        if ($tweak.Recommended) { $badges += New-TWBadge -Text 'EMPFOHLEN' -Color '#2DD4BF' }
        if ($tweak.Pro) { $badges += New-TWBadge -Text 'PRO' -Color '#A855F7' -TextColor 'White' }
        if ($tweak.Restart) { $badges += New-TWBadge -Text 'NEUSTART' -Color '#E3B341' }
        $toggle = New-TWSwitch
        $toggle.Tag = $tweak
        $toggle.Add_Click({ Invoke-TWToggleFromUi -CheckBox $this })
        $script:TweakSwitches += $toggle
        [void]$panel.Children.Add((New-TWRow -Title $tweak.Name -Text $tweak.Effect -Badges $badges -Right $toggle))
    }
    # Gratis-Version: Pro-Funktionen als gesperrte Vorschau zeigen
    $existing = @($script:Tweaks | ForEach-Object { $_.Id })
    foreach ($teaser in @($script:ProTeasers | Where-Object { $_.Category -eq $Category -and $existing -notcontains $_.Id })) {
        $btn = New-TWButton -Text 'Pro freischalten' -Style 'BtnPro'
        $btn.Add_Click({ Open-TWProPage })
        $badges = @(New-TWBadge -Text 'PRO' -Color '#A855F7' -TextColor 'White')
        [void]$panel.Children.Add((New-TWRow -Title $teaser.Name -Text $teaser.Effect -Badges $badges -Right $btn -Dim))
    }
}

function Show-TWWindow {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
    [xml]$xml = $script:Xaml
    $script:Window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xml))
    $isPro = $script:Edition -eq 'Pro'

    # Protokoll
    $script:LogBox = Get-TWControl 'LogBox'
    $script:LogSink = {
        param($Line, $Level)
        $prefix = switch ($Level) { 'Ok' { '✔ ' } 'Warn' { '! ' } 'Error' { '✖ ' } default { '  ' } }
        $script:LogBox.AppendText("$prefix$Line`r`n")
        $script:LogBox.ScrollToEnd()
    }

    # Kopfzeile
    (Get-TWControl 'VersionText').Text = "v$script:AppVersion"
    if ($isPro) {
        (Get-TWControl 'EditionText').Text = 'PRO'
        (Get-TWControl 'EditionText').Foreground = ConvertTo-TWBrush 'White'
        (Get-TWControl 'EditionBadge').Background = ConvertTo-TWBrush '#A855F7'
        (Get-TWControl 'BtnPro').Visibility = 'Collapsed'
    }

    # Tweaks
    Add-TWTweakRows -Category 'Gaming' -PanelName 'GamingTweaks'
    Add-TWTweakRows -Category 'Netzwerk' -PanelName 'NetworkTweaks'

    # Pro-Bereiche ein- oder ausblenden
    if ($isPro) {
        (Get-TWControl 'StartupLocked').Visibility = 'Collapsed'
        (Get-TWControl 'GpuProBadge').Visibility = 'Collapsed'
        (Get-TWControl 'BtnGpuAdd').Add_Click({ Add-TWGpuGameFromDialog })
        (Get-TWControl 'BtnStartupRefresh').Add_Click({ Show-TWStartupList })
    } else {
        (Get-TWControl 'StartupPanel').Visibility = 'Collapsed'
        $gpuButton = Get-TWControl 'BtnGpuAdd'
        $gpuButton.Content = 'Pro freischalten'
        $gpuButton.Style = $script:Window.FindResource('BtnPro')
        $gpuButton.Add_Click({ Open-TWProPage })
        (Get-TWControl 'BtnProStartup').Add_Click({ Open-TWProPage })
    }

    # Knoepfe
    (Get-TWControl 'BtnPro').Add_Click({ Open-TWProPage })
    $restoreAction = {
        Write-TWLog 'Erstelle Wiederherstellungspunkt … (kann eine Minute dauern)'
        Invoke-TWBusy { [void](New-TWRestorePoint) }
        Update-TWStatus
    }
    (Get-TWControl 'BtnRestore').Add_Click($restoreAction)
    (Get-TWControl 'BtnRestore2').Add_Click($restoreAction)
    (Get-TWControl 'BtnRecommended').Add_Click({ Invoke-TWRecommended })
    (Get-TWControl 'BtnPing').Add_Click({ Invoke-TWPingTest })
    (Get-TWControl 'BtnFlushDns').Add_Click({ try { Clear-TWDnsCache } catch { Write-TWLog "DNS-Cache: $($_.Exception.Message)" Error } })
    (Get-TWControl 'BtnClean').Add_Click({ Invoke-TWClean })
    (Get-TWControl 'BtnUndoAll').Add_Click({ Invoke-TWUndoAll })
    (Get-TWControl 'BtnOpenData').Add_Click({ Start-Process explorer.exe $script:DataDir })

    # Beim Oeffnen: System-Info laden und Schalter auf den echten Zustand setzen
    $script:Window.Add_ContentRendered({
            Write-TWLog "$script:AppName $script:AppVersion ($script:Edition) gestartet."
            try {
                $script:SysInfo = Get-TWSystemInfo
                (Get-TWControl 'InfoWindows').Text = $script:SysInfo.Windows
                (Get-TWControl 'InfoCpu').Text = $script:SysInfo.CPU
                (Get-TWControl 'InfoGpu').Text = $script:SysInfo.GPU
                (Get-TWControl 'InfoRam').Text = $script:SysInfo.RAM
                (Get-TWControl 'InfoDisk').Text = $script:SysInfo.Disk
                (Get-TWControl 'InfoDevice').Text = $script:SysInfo.Device
            } catch { Write-TWLog "System-Info: $($_.Exception.Message)" Warn }
            Sync-TWSwitches
            if ($script:Edition -eq 'Pro') { Show-TWGpuList; Show-TWStartupList }
            Write-TWLog 'Bereit. Tipp: Erst einen Wiederherstellungspunkt erstellen.'
        })

    [void]$script:Window.ShowDialog()
}
