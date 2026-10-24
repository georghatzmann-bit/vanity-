# ------------------------------------------------------------------ Start

function Start-TWApp {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $relaunchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', ('"{0}"' -f $PSCommandPath))

    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    $needsClassic = ($PSVersionTable.PSVersion.Major -gt 5) -or
        ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA)

    # Adminrechte (fuer HKLM, Wiederherstellungspunkt, DNS) und Windows PowerShell 5.1 im STA-Modus (fuer WPF)
    if (-not $isAdmin -or $needsClassic) {
        try {
            if ($isAdmin) { Start-Process -FilePath $windowsPowerShell -ArgumentList $relaunchArgs }
            else { Start-Process -FilePath $windowsPowerShell -ArgumentList $relaunchArgs -Verb RunAs }
        } catch {
            Write-Host 'TweakWerk braucht Administratorrechte, um Einstellungen zu ändern. Bitte bei der Windows-Abfrage auf "Ja" klicken.'
            Start-Sleep -Seconds 5
        }
        return
    }

    if (-not (Test-Path -LiteralPath $script:DataDir)) { New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null }
    try {
        Show-TWWindow
    } catch {
        $message = "Unerwarteter Fehler: $($_.Exception.Message)`n`nDetails stehen in: $script:LogFile"
        try { Add-Content -LiteralPath $script:LogFile -Value "[Fatal] $($_ | Out-String)" -Encoding UTF8 } catch { }
        Add-Type -AssemblyName PresentationFramework
        [void][System.Windows.MessageBox]::Show($message, $script:AppName, 'OK', 'Error')
    }
}

Start-TWApp
