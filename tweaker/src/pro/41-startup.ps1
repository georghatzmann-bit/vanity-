# ------------------------------------------------------------------ Pro: Autostart-Manager
# Nutzt denselben Mechanismus wie der Task-Manager (StartupApproved). Nichts wird geloescht:
# Ein Eintrag wird nur als "deaktiviert" markiert und laesst sich jederzeit wieder einschalten.

$script:ApprovedBase = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'

function Get-TWStartupSources {
    @(
        @{ Label = 'Benutzer'; Kind = 'Reg'; Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; Approved = "HKCU:\$script:ApprovedBase\Run" }
        @{ Label = 'Alle Benutzer'; Kind = 'Reg'; Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'; Approved = "HKLM:\$script:ApprovedBase\Run" }
        @{ Label = 'Alle Benutzer (32-Bit)'; Kind = 'Reg'; Path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; Approved = "HKLM:\$script:ApprovedBase\Run32" }
        @{ Label = 'Autostart-Ordner'; Kind = 'Folder'; Path = [Environment]::GetFolderPath('Startup'); Approved = "HKCU:\$script:ApprovedBase\StartupFolder" }
        @{ Label = 'Autostart-Ordner (alle)'; Kind = 'Folder'; Path = [Environment]::GetFolderPath('CommonStartup'); Approved = "HKLM:\$script:ApprovedBase\StartupFolder" }
    )
}

function Test-TWStartupEnabled {
    # Kein Eintrag oder gerades erstes Byte (02, 06) = an; ungerade (03, 07) = aus
    param([byte[]]$Data)
    if (-not $Data -or $Data.Length -eq 0) { return $true }
    return (($Data[0] -band 1) -eq 0)
}

function New-TWStartupApprovedData {
    param([bool]$Enabled, [datetime]$Now = (Get-Date))
    $bytes = New-Object byte[] 12
    if ($Enabled) { $bytes[0] = 2 }
    else {
        $bytes[0] = 3
        [BitConverter]::GetBytes($Now.ToFileTimeUtc()).CopyTo($bytes, 4)
    }
    return , $bytes
}

function Get-TWStartupItems {
    $items = foreach ($src in Get-TWStartupSources) {
        if ($src.Kind -eq 'Reg') {
            foreach ($name in Get-TWRegValueNames -Path $src.Path) {
                $cmd = Get-TWRegValue -Path $src.Path -Name $name
                $approved = Get-TWRegValue -Path $src.Approved -Name $name
                [pscustomobject]@{
                    Name     = $name
                    Command  = "$($cmd.Value)"
                    Source   = $src.Label
                    Approved = $src.Approved
                    Enabled  = Test-TWStartupEnabled $(if ($approved) { [byte[]]$approved.Value } else { $null })
                }
            }
        } elseif ($src.Path -and (Test-Path -LiteralPath $src.Path)) {
            foreach ($file in Get-ChildItem -LiteralPath $src.Path -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' }) {
                $approved = Get-TWRegValue -Path $src.Approved -Name $file.Name
                [pscustomobject]@{
                    Name     = $file.Name
                    Command  = $file.FullName
                    Source   = $src.Label
                    Approved = $src.Approved
                    Enabled  = Test-TWStartupEnabled $(if ($approved) { [byte[]]$approved.Value } else { $null })
                }
            }
        }
    }
    @($items | Sort-Object Name)
}

function Set-TWStartupItem {
    param($Item, [bool]$Enabled)
    Set-TWRegValue -Path $Item.Approved -Name $Item.Name -Type 'Binary' -Value (New-TWStartupApprovedData -Enabled $Enabled)
    $state = 'aus'
    if ($Enabled) { $state = 'an' }
    Write-TWLog "Autostart '$($Item.Name)': $state" Ok
}
