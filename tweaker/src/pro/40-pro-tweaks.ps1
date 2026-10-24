# ------------------------------------------------------------------ Pro: zusaetzliche Tweaks und Spiel-Profile

function Get-TWActiveAdapters {
    @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' })
}

$script:CloudflareDns = @('1.1.1.1', '1.0.0.1')

$script:Tweaks += @(
    @{
        Id          = 'HAGS'
        Name        = 'Hardware-beschleunigte GPU-Planung'
        Effect      = 'Die Grafikkarte verwaltet ihren Speicher selbst. Kann den Input-Lag etwas senken und ist Pflicht für DLSS Frame Generation. Braucht eine neuere GPU (ab GTX 1000 / RX 5000) und einen Neustart.'
        Category    = 'Gaming'
        Pro         = $true
        Recommended = $false
        Restart     = $true
        Registry    = @(
            @{ Path = 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers'; Name = 'HwSchMode'; Type = 'DWord'; On = 2; Off = 1 }
        )
    }
    @{
        Id          = 'DeliveryOpt'
        Name        = 'Update-Upload an fremde PCs aus'
        Effect      = 'Windows verteilt Updates nicht mehr über deine Leitung an andere PCs im Internet. Das spart Upload, der sonst im Hintergrund deinen Ping stören kann. Updates selbst laufen ganz normal weiter.'
        Category    = 'Netzwerk'
        Pro         = $true
        Recommended = $true
        Registry    = @(
            @{ Path = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization'; Name = 'DODownloadMode'; Type = 'DWord'; On = 0; Off = $null }
        )
    }
    @{
        Id          = 'DnsCloudflare'
        Name        = 'Schneller DNS (Cloudflare 1.1.1.1)'
        Effect      = 'Launcher, Webseiten und Matchmaking finden ihre Server schneller. Ehrlich gesagt: Deinen Ping IM Spiel ändert DNS nicht. Wer das verspricht, lügt.'
        Category    = 'Netzwerk'
        Pro         = $true
        Recommended = $false
        Capture     = {
            , @(foreach ($a in Get-TWActiveAdapters) {
                    $static = Get-TWRegValue -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($a.InterfaceGuid)" -Name 'NameServer'
                    [pscustomobject]@{
                        Index   = $a.ifIndex
                        Alias   = $a.Name
                        Static  = [bool]($static -and $static.Value)
                        Servers = @((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4).ServerAddresses)
                    }
                })
        }
        Apply       = {
            $adapters = Get-TWActiveAdapters
            if (-not $adapters) { throw 'Kein aktiver Netzwerkadapter gefunden.' }
            foreach ($a in $adapters) {
                Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses $script:CloudflareDns -ErrorAction Stop
            }
            Clear-DnsClientCache
        }
        Revert      = {
            param($Saved)
            $entries = @($Saved | Where-Object { $_ })
            if ($entries) {
                foreach ($s in $entries) {
                    try {
                        if ($s.Static -and $s.Servers) {
                            Set-DnsClientServerAddress -InterfaceIndex $s.Index -ServerAddresses @($s.Servers) -ErrorAction Stop
                        } else {
                            Set-DnsClientServerAddress -InterfaceIndex $s.Index -ResetServerAddresses -ErrorAction Stop
                        }
                    } catch { Write-TWLog "DNS für '$($s.Alias)' nicht zurückgesetzt (Adapter nicht gefunden?)" Warn }
                }
            } else {
                foreach ($a in Get-TWActiveAdapters) { Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ResetServerAddresses }
            }
            Clear-DnsClientCache
        }
        Test        = {
            $adapters = Get-TWActiveAdapters
            if (-not $adapters) { return $false }
            foreach ($a in $adapters) {
                $servers = @((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4).ServerAddresses)
                if ($servers -notcontains $script:CloudflareDns[0]) { return $false }
            }
            return $true
        }
    }
)

# --- Spiel-Profile: Spiel immer auf der starken Grafikkarte (wichtig bei Laptops mit 2 GPUs) ---

$script:GpuPrefPath = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'

function Get-TWGpuPreferences {
    @(foreach ($name in Get-TWRegValueNames -Path $script:GpuPrefPath) {
            $v = Get-TWRegValue -Path $script:GpuPrefPath -Name $name
            if ($v -and "$($v.Value)" -match 'GpuPreference=2') { $name }
        })
}

function Add-TWGpuPreference {
    param([string]$ExePath)
    Set-TWRegValue -Path $script:GpuPrefPath -Name $ExePath -Type 'String' -Value 'GpuPreference=2;'
    Write-TWLog "Hochleistungs-GPU für $(Split-Path -Leaf $ExePath) eingestellt." Ok
}

function Remove-TWGpuPreference {
    param([string]$ExePath)
    Remove-TWRegValue -Path $script:GpuPrefPath -Name $ExePath
    Write-TWLog "GPU-Einstellung für $(Split-Path -Leaf $ExePath) entfernt." Ok
}
